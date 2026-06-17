// Tests the #3 triage gate DEFAULT_RULE: a bug ticket on ticket:created spawns
// the cheap triage-scout to verify it still reproduces before dispatch.
//
// Coverage:
//  1. a ticket labeled "bug" → spawns triage-scout, once.
//  2. a ticket WITHOUT the bug label → no triage spawn (feature/chore skip it).
//  3. fire-and-forget: the scout exiting without a VERDICT produces no
//     "manual intervention" comment (expectVerdict:false → untracked).
//
// Real bus + DEFAULT_RULES, stubbed spawnAgent. No real Claude.

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-triage-"));
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

describe("triage gate rule (#3) — verify bug tickets on creation", () => {
  it("spawns triage-scout for a bug-labeled ticket", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-bug-" + Date.now(),
      title: "Crash on null input",
      description: "see foo.ts:42",
      status: "backlog",
      reviewPhase: null,
      labels: ["bug", "qa-2026-06"],
      reworkCount: 0,
      assigneeProfileId: null,
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:created", { ticketId: ticket.id, title: ticket.title, priority: "medium" });
    await new Promise((r) => setTimeout(r, 300));

    const mine = spawns.filter((s) => s.ticketId === ticket.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].profileId).toBe("triage-scout");
    expect(mine[0].prompt).toContain("Triage bug ticket");
  });

  it("does NOT triage a ticket without the bug label", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-feat-" + Date.now(),
      title: "Add dark mode",
      description: "feature work",
      status: "backlog",
      reviewPhase: null,
      labels: ["feature", "enhancement"],
      reworkCount: 0,
      assigneeProfileId: null,
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:created", { ticketId: ticket.id, title: ticket.title, priority: "medium" });
    await new Promise((r) => setTimeout(r, 300));

    expect(spawns.filter((s) => s.ticketId === ticket.id)).toHaveLength(0);
  });

  it("is fire-and-forget: scout exiting with no VERDICT produces no intervention comment", async () => {
    const { bus, spawns } = await setup();
    const comments: any[] = [];
    watcher._setServiceOverride({
      addComment: (...a: any[]) => { comments.push(a); return { ok: true }; },
      updateStatus: () => ({ ok: true }),
      updateReviewPhase: () => ({ ok: true }),
      completeTicket: () => ({ ok: true }),
      getTicket: () => null,
    });
    const ticket: any = {
      id: "t-bugff-" + Date.now(),
      title: "Flaky test",
      description: "x",
      status: "backlog",
      reviewPhase: null,
      labels: ["bug"],
      reworkCount: 0,
      assigneeProfileId: null,
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:created", { ticketId: ticket.id, title: ticket.title, priority: "low" });
    await new Promise((r) => setTimeout(r, 300));
    expect(spawns.filter((s) => s.ticketId === ticket.id)).toHaveLength(1);

    bus.emit("agent:terminated", { agentId: "agent-1", reason: "completed", exitCode: 0, output: "ALREADY-FIXED: lifecycle.ts now guards null" });
    await new Promise((r) => setTimeout(r, 20));

    expect(comments).toHaveLength(0);
  });
});
