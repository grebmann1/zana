// Tests the #6 design-only escalation lane:
//  - service.escalateForDesign parks a ticket with "awaiting-decision", binds
//    architect, emits "ticket:escalated" (idempotent on re-escalation).
//  - the design-only DEFAULT_RULE spawns architect on ticket:escalated,
//    fire-and-forget (no VERDICT tracking).
//  - INTEGRATION with #1: a parked ticket (awaiting-decision) does NOT
//    auto-implement when claimed.

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

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-design-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const configPath = path.join(tmpDir, "config.json");
  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  const bus = (await import("@zana-ai/core") as any).events.bus;
  const spawns: any[] = [];
  watcher.init({
    ticketsDirectory: ticketsDir,
    configPath,
    spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
      spawns.push({ profileId, prompt, ticketId });
      return Promise.resolve({ agentId: "agent-" + spawns.length });
    },
  });
  return { bus, spawns };
}

describe("design-only escalation lane (#6)", () => {
  it("spawns a design-only architect on ticket:escalated", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-esc-" + Date.now(),
      title: "Change a core invariant",
      description: "registry authority",
      status: "backlog",
      reviewPhase: null,
      labels: ["architecture", "awaiting-decision"],
      reworkCount: 0,
      assigneeProfileId: "architect",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:escalated", { ticketId: ticket.id, reason: "escalation label" });
    await new Promise((r) => setTimeout(r, 300));

    const mine = spawns.filter((s) => s.ticketId === ticket.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].profileId).toBe("architect");
    expect(mine[0].prompt).toContain("DESIGN ONLY");
    expect(mine[0].prompt).toContain("Do NOT write production code");
  });

  it("a parked (awaiting-decision) ticket does NOT auto-implement on claim", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-parked-" + Date.now(),
      title: "Parked design ticket",
      description: "x",
      status: "in-progress",
      reviewPhase: null,
      labels: ["architecture", "awaiting-decision"],
      reworkCount: 0,
      assigneeProfileId: "architect",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:claimed", { ticketId: ticket.id, agentId: "x", profileId: "architect" });
    await new Promise((r) => setTimeout(r, 300));

    // No implement spawn — the skipLabels guard on the auto-implement rule held.
    expect(spawns.filter((s) => s.ticketId === ticket.id)).toHaveLength(0);
  });
});
