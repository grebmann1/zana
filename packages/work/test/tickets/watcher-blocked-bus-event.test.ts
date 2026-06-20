// When a ticket exhausts its rework cycles, executeAutomation short-circuits to
// markBlocked(). Existing coverage asserts the ticket is moved to "blocked" and
// NOT re-spawned (watcher-stress), but nothing asserts the documented
// `ticket:blocked` bus event markBlocked emits. Downstream consumers (e.g. a
// human-escalation notifier) subscribe to that event and rely on its payload
// shape — { ticketId, reason: "max_rework_cycles", reworkCount } — so it is a
// real contract worth pinning.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string | null = null;
let watcher: any = null;

afterEach(() => {
  if (watcher) {
    try { watcher._setServiceOverride(null); } catch {}
    try { watcher._setReadTicketOverride(null); } catch {}
    try { if (watcher.isRunning()) watcher.stop(); } catch {}
    try { watcher._resetDedup(); } catch {}
  }
  watcher = null;
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  tmpDir = null;
});

async function boot() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-blocked-evt-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  const bus = (await import("@zana-ai/core") as any).events.bus;
  const spawns: any[] = [];
  watcher.init({
    ticketsDirectory: ticketsDir,
    configPath: path.join(tmpDir, "config.json"),
    spawnAgent: (profileId: string, _p: string, ticketId: string) => {
      const agentId = `a-${spawns.length + 1}`;
      spawns.push({ profileId, ticketId });
      return Promise.resolve({ agentId });
    },
  });
  return { bus, spawns };
}

const tick = (ms = 2600) => new Promise((r) => setTimeout(r, ms));

describe("ticket-watcher: rework-cap emits ticket:blocked bus event", () => {
  it("emits ticket:blocked with reason=max_rework_cycles when cycles are exhausted", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    const blockedEvents: any[] = [];

    const onBlocked = (msg: any) => blockedEvents.push(msg);
    bus.on("ticket:blocked", onBlocked);

    try {
      watcher._setReadTicketOverride((id: string) => store[id] || null);
      watcher._setServiceOverride({
        addComment: () => ({ ok: true }),
        updateStatus: (id: string, s: string) => { if (store[id]) store[id].status = s; return { ok: true }; },
        updateReviewPhase: () => ({ ok: true }),
        completeTicket: () => ({ ok: true }),
        getTicket: (id: string) => store[id] || null,
      });

      // Ticket already at the rework cap (3). The next rework transition must
      // be auto-blocked rather than re-spawned.
      store["cap-1"] = {
        id: "cap-1",
        title: "perma-failing",
        description: "d",
        status: "rework",
        labels: [],
        reviewPhase: null,
        reworkCount: 3,
        assigneeProfileId: "backend-dev",
      };
      bus.emit("ticket:statusChanged", { ticketId: "cap-1", oldStatus: "review", newStatus: "rework" });
      await tick();

      // No worker spawned for a capped ticket.
      expect(spawns.filter((s) => s.ticketId === "cap-1")).toHaveLength(0);

      // Exactly one ticket:blocked event with the documented payload shape.
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0]).toMatchObject({
        ticketId: "cap-1",
        reason: "max_rework_cycles",
        reworkCount: 3,
      });
    } finally {
      bus.off("ticket:blocked", onBlocked);
    }
  }, 30_000);
});
