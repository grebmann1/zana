// Reproduction + regression test for the QA→architecture auto-review handoff.
//
// BUG: the default architect rule triggers on `ticket:statusChanged` with
// reviewPhase="architecture". But QA→architecture is advanced via
// updateReviewPhase(), which emits `ticket:reviewPhaseChanged` (status stays
// "review"). matchesRule rejects on event mismatch, so the architect rule
// never fires and the ticket strands at review/architecture.
//
// This test drives the REAL event sequence (statusChanged→review, then
// reviewPhaseChanged qa→architecture) and asserts an architect is spawned.
// No real Claude, no real SQLite — spawnAgent is a recording fake.
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

describe("watcher — QA→architecture handoff spawns architect", () => {
  it("spawns the architect profile when the ticket advances to reviewPhase=architecture", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-handoff-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const ticket: any = {
      id: "t-handoff-" + Date.now(),
      title: "Handoff test",
      description: "",
      status: "review",
      reviewPhase: "qa",
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

    // Real production sequence: the QA reviewer PASSes, watcher advances the
    // phase via updateReviewPhase → mutates the ticket to architecture and
    // emits reviewPhaseChanged (NOT statusChanged). readTicket sees the new
    // phase by the time the event is processed.
    ticket.reviewPhase = "architecture";
    bus.emit("ticket:reviewPhaseChanged", {
      ticketId: ticket.id,
      oldPhase: "qa",
      newPhase: "architecture",
      updatedBy: "ticket-watcher",
    });
    await new Promise((r) => setTimeout(r, 300));

    const archSpawn = spawns.find((s) => s.profileId === "architect");
    expect(archSpawn, "an architect should be auto-spawned on the architecture phase").toBeTruthy();
    expect(archSpawn!.ticketId).toBe(ticket.id);
  });
});
