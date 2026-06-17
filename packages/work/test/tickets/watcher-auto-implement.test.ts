// Tests the #1 "auto-implement" DEFAULT_RULE: when a ticket is CLAIMED with a
// bound assigneeProfileId, the watcher spawns that profile to do the work.
// This closes the front of the pipeline (the review rules only covered what
// happens AFTER implementation).
//
// Coverage:
//  1. claim with a profile → spawns exactly that profile, once.
//  2. claim with NO profile ({{assigneeProfileId}} unresolved) → no spawn.
//  3. ticket carrying the "awaiting-decision" skip label → no spawn (design-only
//     tickets are parked for a human; auto-implement must not fire).
//  4. the spawn is fire-and-forget (expectVerdict:false) → a terminated agent
//     with no VERDICT does NOT get the "manual intervention needed" comment.
//
// Driven through the REAL bus + DEFAULT_RULES (no custom config). No real
// Claude, no real SQLite, no real spawns.

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-auto-impl-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  // No automation.json → DEFAULT_RULES (which now include "auto-implement").
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

describe("auto-implement rule (#1) — spawn the bound profile on ticket:claimed", () => {
  it("spawns exactly the assigned profile, once, with an implement prompt", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-impl-" + Date.now(),
      title: "Add the thing",
      description: "implement the feature",
      status: "in-progress",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "backend-dev",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:claimed", { ticketId: ticket.id, agentId: "x", profileId: "backend-dev" });
    await new Promise((r) => setTimeout(r, 300));

    const mine = spawns.filter((s) => s.ticketId === ticket.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].profileId).toBe("backend-dev");
    expect(mine[0].prompt).toContain("Implement ticket");
    // Drives its own transition via the MCP tool, not a VERDICT line.
    expect(mine[0].prompt).toContain("zana_ticket_update");
  });

  it("does NOT spawn when the ticket has no bound profile", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-noprof-" + Date.now(),
      title: "Orphan",
      description: "no profile bound",
      status: "in-progress",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
      assigneeProfileId: null, // {{assigneeProfileId}} renders empty → unresolved
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:claimed", { ticketId: ticket.id, agentId: "x", profileId: null });
    await new Promise((r) => setTimeout(r, 300));

    expect(spawns.filter((s) => s.ticketId === ticket.id)).toHaveLength(0);
  });

  it("does NOT spawn for a ticket parked with the awaiting-decision label", async () => {
    const { bus, spawns } = await setup();
    const ticket: any = {
      id: "t-parked-" + Date.now(),
      title: "Design-only, parked for human",
      description: "changes a core invariant",
      status: "in-progress",
      reviewPhase: null,
      labels: ["awaiting-decision"],
      reworkCount: 0,
      assigneeProfileId: "architect",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:claimed", { ticketId: ticket.id, agentId: "x", profileId: "architect" });
    await new Promise((r) => setTimeout(r, 300));

    expect(spawns.filter((s) => s.ticketId === ticket.id)).toHaveLength(0);
  });

  it("is fire-and-forget: a terminated implementer with no VERDICT gets no 'manual intervention' comment", async () => {
    const { bus, spawns } = await setup();
    const comments: any[] = [];
    watcher._setServiceOverride({
      addComment: (...a: any[]) => { comments.push(a); return { ok: true }; },
      updateStatus: () => ({ ok: true }),
      updateReviewPhase: () => ({ ok: true }),
      completeTicket: () => ({ ok: true }),
      getTicket: (id: string) => null,
    });
    const ticket: any = {
      id: "t-ff-" + Date.now(),
      title: "Fire and forget",
      description: "implement",
      status: "in-progress",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "backend-dev",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    bus.emit("ticket:claimed", { ticketId: ticket.id, agentId: "x", profileId: "backend-dev" });
    await new Promise((r) => setTimeout(r, 300));
    const mine = spawns.filter((s) => s.ticketId === ticket.id);
    expect(mine).toHaveLength(1);

    // The implementer exits without a VERDICT line (it used MCP tools instead).
    bus.emit("agent:terminated", { agentId: "agent-1", reason: "completed", exitCode: 0, output: "done, moved to review" });
    await new Promise((r) => setTimeout(r, 20));

    // Because expectVerdict:false, the spawn was never tracked → no comment.
    expect(comments).toHaveLength(0);
  });
});
