// Negative-guard regression test, complement of watcher-arch-phase-handoff.
//
// The default architect rule used to trigger on `ticket:statusChanged` with
// reviewPhase="architecture". That never fired in practice: the only
// statusChanged into "review" auto-sets reviewPhase=qa, and the qa→architecture
// advance happens via updateReviewPhase() which emits `ticket:reviewPhaseChanged`
// (status stays "review"). The fix re-bound the rule to ticket:reviewPhaseChanged.
//
// The positive case (architect spawns on reviewPhaseChanged) is pinned by
// watcher-arch-phase-handoff.test.ts. This file pins the OTHER direction: a
// `ticket:statusChanged` event must NOT spawn the architect, even when the
// ticket already carries reviewPhase="architecture". Reverting the trigger back
// to statusChanged would break this and resurrect the stranded-ticket bug.
//
// No real Claude, no real SQLite — spawnAgent is a recording fake, only the
// built-in DEFAULT_RULES are loaded (configPath points at a nonexistent file).
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

describe("watcher — architect does NOT spawn on ticket:statusChanged", () => {
  it("ignores a statusChanged event even when the ticket reviewPhase is already 'architecture'", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-arch-neg-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    // Ticket is in review with reviewPhase already at "architecture". If the
    // architect rule were (wrongly) bound to statusChanged, this payload would
    // match and spawn an architect.
    const ticket: any = {
      id: "t-arch-neg-" + Date.now(),
      title: "Negative arch guard",
      description: "",
      status: "review",
      reviewPhase: "architecture",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "backend-dev",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    const spawns: Array<{ profileId: string; prompt: string; ticketId: string }> = [];
    let n = 0;
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        spawns.push({ profileId, prompt, ticketId });
        return Promise.resolve({ agentId: `fake-agent-${++n}` });
      },
    });

    // Drive a statusChanged event into review. The architect rule listens for
    // ticket:reviewPhaseChanged, so this must not trigger it.
    bus.emit("ticket:statusChanged", {
      ticketId: ticket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "tester",
    });
    await new Promise((r) => setTimeout(r, 300));

    const archSpawn = spawns.find((s) => s.profileId === "architect");
    expect(archSpawn, "architect must NOT spawn on a statusChanged event").toBeUndefined();
  });
});
