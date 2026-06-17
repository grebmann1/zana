// Regression test for the branch/worktree-blind reviewer (defect #1).
//
// Before the fix, a reviewer that could not locate the implementation on the
// checked-out tree (because the work was committed on a DIFFERENT branch or in
// a separate git worktree) emitted a confident VERDICT: FAIL, which forced the
// ticket review → rework. This produced 100% false negatives for work that was
// complete but not on HEAD.
//
// The fix adds an INCONCLUSIVE verdict: "I inspected a tree and did not find the
// work" must NOT transition the ticket. It stays in review (for a re-review
// against the correct tree) and an audit comment is recorded.
//
// Exercised at integration level via the two bus events the real watcher
// listens for (ticket:statusChanged → agent:terminated), mirroring
// watcher-apply-verdict-fail.test.ts. No real Claude / SQLite / spawns.

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

describe("applyVerdict — INCONCLUSIVE leaves the ticket in review (no false rework)", () => {
  it("does NOT transition to rework when the reviewer cannot locate the work", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-inconclusive-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-inconclusive-" + Date.now(),
      title: "Work is on another branch",
      description: "committed on branch 0.8.3, not HEAD",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-inconclusive-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-inconclusive-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Searched the checked-out tree, found no matching implementation.\nVERDICT: INCONCLUSIVE — not found on inspected tree (HEAD)",
    });
    await new Promise((r) => setTimeout(r, 20));

    // The ticket must STAY in review — never forced to rework on a not-found.
    expect(fakeTicket.status).toBe("review");
    expect(svc.calls.some((c: any) => c[0] === "updateStatus")).toBe(false);
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);

    // An audit comment recording the inconclusive finding must be added.
    const comment = svc.calls.find((c: any) => c[0] === "addComment");
    expect(comment).toBeTruthy();
    expect(comment[4]).toMatch(/INCONCLUSIVE/i);
  });
});
