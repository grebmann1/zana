// Tests the applyVerdict READY path in watcher.ts (lines 603-613):
//
//   } else if (verdict.kind === "READY") {
//     const toInProgress = ticketService.updateStatus(ticket.id, "in-progress", actor);
//     if (toInProgress && toInProgress.ok) {
//       const toReview = ticketService.updateStatus(ticket.id, "review", actor);
//       if (toReview && toReview.ok) {
//         ticketService.updateReviewPhase(ticket.id, "qa", actor);
//       }
//     }
//   }
//
// A rework agent that finishes its fixes emits "VERDICT: READY". Because the
// status-transition map forbids rework→review directly, the watcher must walk
// the ticket back through in-progress before re-entering review at the qa
// phase. This test drives that behavior at the integration level (the same two
// bus events the real watcher listens for) and asserts the exact 3-call
// sequence, in order, plus the guard that each step only runs if the prior
// updateStatus returned { ok: true }.
//
// No real Claude, no real SQLite, no real spawns.

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string | null = null;
let watcher: any = null;

// Warm the heavy @zana-ai/work ↔ @zana-ai/core require-cycle ONCE, off the
// per-test clock. The first cold import of this graph can exceed the default
// 5s test timeout under full-suite parallel CPU contention; pre-loading it
// here (with a generous hook budget) keeps each test's own import a cache hit
// so the 5s budget covers only the ~300ms debounce logic it actually exercises.
beforeAll(async () => {
  await import("@zana-ai/work/src/tickets/watcher.ts");
  await import("@zana-ai/core");
}, 60_000);

function makeStubService(ticket: any, opts: { failInProgress?: boolean } = {}) {
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
      // Simulate the transition map rejecting the rework→in-progress hop.
      if (status === "in-progress" && opts.failInProgress) return { ok: false };
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

describe("applyVerdict — READY verdict walks rework back to review/qa", () => {
  it("does updateStatus('in-progress') → updateStatus('review') → updateReviewPhase('qa') in order", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-ready-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-ready-" + Date.now(),
      title: "Reworked ticket",
      description: "fix the issues",
      status: "rework",
      reviewPhase: null,
      labels: [],
      reworkCount: 1,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-ready-agent-1" }),
    });

    // The default "rework" rule fires on a status change into rework.
    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "review",
      newStatus: "rework",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-ready-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Addressed all reviewer feedback.\nVERDICT: READY",
    });
    await new Promise((r) => setTimeout(r, 20));

    // Ticket ends back in review at the qa phase, ready for re-review.
    expect(fakeTicket.status).toBe("review");
    expect(fakeTicket.reviewPhase).toBe("qa");

    // The three state-mutating calls happened in the exact required order.
    const transitions = svc.calls
      .filter((c: any) => c[0] === "updateStatus" || c[0] === "updateReviewPhase")
      .map((c: any) => `${c[0]}:${c[2]}`);
    expect(transitions).toEqual([
      "updateStatus:in-progress",
      "updateStatus:review",
      "updateReviewPhase:qa",
    ]);

    // READY must NOT complete the ticket.
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);
  });

  it("stops after updateStatus('in-progress') when that hop is rejected (ok:false guard)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-ready-guard-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-ready-guard-" + Date.now(),
      title: "Reworked ticket, blocked hop",
      description: "fix the issues",
      status: "rework",
      reviewPhase: null,
      labels: [],
      reworkCount: 1,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket, { failInProgress: true });
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-ready-guard-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "review",
      newStatus: "rework",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-ready-guard-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Done.\nVERDICT: READY",
    });
    await new Promise((r) => setTimeout(r, 20));

    // The in-progress hop was attempted but rejected; the chain must not proceed.
    const transitions = svc.calls
      .filter((c: any) => c[0] === "updateStatus" || c[0] === "updateReviewPhase")
      .map((c: any) => `${c[0]}:${c[2]}`);
    expect(transitions).toEqual(["updateStatus:in-progress"]);
    expect(svc.calls.some((c: any) => c[0] === "updateReviewPhase")).toBe(false);
  });
});
