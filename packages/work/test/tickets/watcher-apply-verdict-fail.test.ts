// Tests the applyVerdict FAIL path in watcher.ts (lines 595-597):
//
//   } else if (verdict.kind === "FAIL") {
//     ticketService.updateStatus(ticket.id, "rework", actor);
//   }
//
// This path is exercised at integration level: the test emits the two bus
// events that the real watcher listens for (ticket:statusChanged followed by
// agent:terminated) and confirms that the stub service receives the expected
// updateStatus("rework") call.
//
// Covered behaviours:
//   • FAIL verdict → updateStatus("rework", "ticket-watcher") called
//   • FAIL verdict → an audit comment is added before the transition
//   • FAIL verdict → ticket.status does NOT become "done" or "review"
//   • PASS in qa reviewPhase → updateReviewPhase("architecture") called
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

describe("applyVerdict — FAIL verdict → updateStatus('rework')", () => {
  it("calls updateStatus('rework') when the review agent emits VERDICT: FAIL", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-fail-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-fail-" + Date.now(),
      title: "Failing ticket",
      description: "needs work",
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
      spawnAgent: () => Promise.resolve({ agentId: "fake-fail-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-fail-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Several issues found in the implementation.\nVERDICT: FAIL — missing error handling",
    });
    await new Promise((r) => setTimeout(r, 20));

    // FAIL must route the ticket to rework.
    expect(fakeTicket.status).toBe("rework");
    const reworkCall = svc.calls.find((c: any) => c[0] === "updateStatus" && c[2] === "rework");
    expect(reworkCall).toBeTruthy();
    expect(reworkCall[1]).toBe(fakeTicket.id);
    expect(reworkCall[3]).toBe("ticket-watcher");

    // completeTicket must NOT have been called.
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);

    // An audit comment must have been added before the transition.
    const comment = svc.calls.find((c: any) => c[0] === "addComment");
    expect(comment).toBeTruthy();
    expect(comment[4]).toMatch(/FAIL/i);
  });
});

describe("applyVerdict — PASS in qa phase → updateReviewPhase('architecture')", () => {
  it("advances reviewPhase to 'architecture' when a PASS arrives in the qa phase", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-qa-pass-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-qa-pass-" + Date.now(),
      title: "QA Pass ticket",
      description: "good work",
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
      spawnAgent: () => Promise.resolve({ agentId: "fake-qa-pass-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-qa-pass-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Code quality is solid.\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    // PASS in qa → advance to architecture review.
    expect(fakeTicket.reviewPhase).toBe("architecture");
    const phaseCall = svc.calls.find((c: any) => c[0] === "updateReviewPhase" && c[2] === "architecture");
    expect(phaseCall).toBeTruthy();
    expect(phaseCall[1]).toBe(fakeTicket.id);

    // completeTicket must NOT have been called (that only happens in the architecture phase).
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);
  });
});
