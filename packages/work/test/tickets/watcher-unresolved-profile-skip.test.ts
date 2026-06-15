// Tests the unresolved-profile guard in executeAutomation (watcher.ts):
//
//   const profileId = renderTemplate(rule.action.spawnProfile, ctx);
//   if (!profileId || profileId.includes("{{")) {
//     log(`Cannot resolve profile for ticket ${ticket.id}: ...`);
//     return;
//   }
//
// The default "rework" rule spawns `{{assigneeProfileId}}`. When a ticket
// reaches "rework" but carries no assigneeProfileId, renderTemplate collapses
// the token to an empty string, the guard trips, and NO agent is spawned —
// the watcher must not call spawnAgent with an empty/garbage profile id.
//
// Regression target: a watcher that spawned anyway would launch an agent with
// an empty profile id, which the spawner can't resolve to a real Claude
// profile. This asserts the guard short-circuits before any spawn.
//
// No real Claude, no real SQLite, no real spawns.

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

describe("executeAutomation — unresolved spawnProfile skips the spawn", () => {
  it("does NOT spawn an agent when {{assigneeProfileId}} resolves to empty", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-unresolved-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    // rework ticket with NO assigneeProfileId — the rework rule's
    // "{{assigneeProfileId}}" template can't resolve. reworkCount stays below
    // MAX_REWORK_CYCLES so the markBlocked path is not what's under test here.
    const fakeTicket: any = {
      id: "t-no-profile-" + Date.now(),
      title: "Reworked ticket without assignee profile",
      description: "fix the issues",
      status: "rework",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
      // assigneeProfileId intentionally omitted
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    const spawnCalls: any[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        spawnCalls.push({ profileId, prompt, ticketId });
        return Promise.resolve({ agentId: "should-not-happen" });
      },
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "review",
      newStatus: "rework",
      updatedBy: "test",
    });
    // Wait past the 150ms debounce plus a margin for the queued spawn attempt.
    await new Promise((r) => setTimeout(r, 300));

    expect(spawnCalls).toEqual([]);
  });
});
