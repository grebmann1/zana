// Tests the applyVerdict BLOCKED path in watcher.ts (lines 614-616):
//
//   } else if (verdict.kind === "BLOCKED") {
//     ticketService.updateStatus(ticket.id, "blocked", actor);
//   }
//
// A rework agent that cannot finish emits "VERDICT: BLOCKED — <reason>".
// The watcher must drive the ticket to status="blocked" (human intervention)
// and must NOT advance it through the review pipeline or complete it.
//
// This is exercised at the integration level — the same two bus events the
// real watcher listens for (ticket:statusChanged into rework, then
// agent:terminated). The rework rule must spawn the assignee profile so the
// agent gets tracked in inFlightSpawns; the BLOCKED verdict is then applied
// when the agent terminates.
//
// Covered behaviours:
//   • BLOCKED verdict → updateStatus("blocked", "ticket-watcher") is called.
//   • BLOCKED verdict → the reason is captured in an audit comment.
//   • BLOCKED verdict → ticket is NOT completed and NOT routed to review/qa.
//
// No real Claude, no real SQLite, no real spawns.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string | null = null;
let watcher: any = null;

function makeStubService(ticket: any) {
  const calls: any[] = [];
  const stub = {
    calls,
    addComment: (...a: any[]) => { calls.push(["addComment", ...a]); return { ok: true }; },
    updateReviewPhase: (id: string, phase: string, actor: string) => {
      calls.push(["updateReviewPhase", id, phase, actor]);
      if (id === ticket.id) ticket.reviewPhase = phase;
      return { ok: true };
    },
    updateStatus: (id: string, status: string, actor: string) => {
      calls.push(["updateStatus", id, status, actor]);
      if (id === ticket.id) ticket.status = status;
      return { ok: true };
    },
    completeTicket: (id: string, summary: string, actor: string) => {
      calls.push(["completeTicket", id, summary, actor]);
      if (id === ticket.id) ticket.status = "done";
      return { ok: true };
    },
    getTicket: (id: string) => (id === ticket.id ? ticket : null),
  };
  return stub;
}

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

describe("applyVerdict — BLOCKED verdict → updateStatus('blocked')", () => {
  it("moves the ticket to blocked and records the reason when a rework agent emits VERDICT: BLOCKED", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-blocked-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-blocked-" + Date.now(),
      title: "Reworked ticket that cannot proceed",
      description: "needs a decision",
      status: "rework",
      reviewPhase: null,
      labels: [],
      reworkCount: 1, // below MAX_REWORK_CYCLES so the spawn proceeds
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-blocked-agent-1" }),
    });

    // Entering rework triggers the default rework rule, which spawns the
    // assignee profile and tracks the in-flight agent.
    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "review",
      newStatus: "rework",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-blocked-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Could not resolve the dependency conflict.\nVERDICT: BLOCKED — upstream API contract is undecided",
    });
    await new Promise((r) => setTimeout(r, 20));

    // BLOCKED routes the ticket to blocked.
    expect(fakeTicket.status).toBe("blocked");
    const blockedCall = svc.calls.find((c: any) => c[0] === "updateStatus" && c[2] === "blocked");
    expect(blockedCall).toBeTruthy();
    expect(blockedCall[1]).toBe(fakeTicket.id);
    expect(blockedCall[3]).toBe("ticket-watcher");

    // The reason must be captured in an audit comment.
    const comment = svc.calls.find(
      (c: any) => c[0] === "addComment" && /BLOCKED/i.test(c[4]) && /undecided/.test(c[4]),
    );
    expect(comment).toBeTruthy();

    // It must NOT complete the ticket nor route it back into review/qa.
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);
    expect(svc.calls.some((c: any) => c[0] === "updateStatus" && c[2] === "review")).toBe(false);
    expect(svc.calls.some((c: any) => c[0] === "updateReviewPhase")).toBe(false);
  });
});
