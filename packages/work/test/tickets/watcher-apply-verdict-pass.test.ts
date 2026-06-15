// Tests the applyVerdict PASS path in watcher.ts (lines 592-599):
//
//   if (verdict.kind === "PASS") {
//     if (ticket.reviewPhase === "qa") {
//       ticketService.updateReviewPhase(ticket.id, "architecture", actor);
//     } else if (ticket.reviewPhase === "architecture") {
//       ticketService.completeTicket(ticket.id, "Approved by automated review pipeline.", actor);
//     }
//   }
//
// FAIL, READY, and BLOCKED each already have a dedicated apply-verdict test;
// the PASS branch — which advances the review pipeline — did not. This drives
// the REAL bus sequence the watcher listens for (rule fire → spawn →
// agent:terminated with "VERDICT: PASS") and asserts:
//   * a qa-phase PASS advances reviewPhase to "architecture" (does NOT complete)
//   * an architecture-phase PASS completes the ticket (does NOT re-phase)
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

describe("applyVerdict — PASS verdict advances the review pipeline", () => {
  it("advances reviewPhase qa → architecture on a qa-phase PASS (does not complete)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-pass-qa-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const ticket: any = {
      id: "t-pass-qa-" + Date.now(),
      title: "QA pass ticket",
      description: "implement the feature",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));
    const svc = makeStubService(ticket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-qa-pass-agent-1" }),
    });

    // Default qa rule fires on a status change into review (reviewPhase=qa).
    bus.emit("ticket:statusChanged", {
      ticketId: ticket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-qa-pass-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Correctness and security look good.\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(ticket.reviewPhase).toBe("architecture");
    expect(ticket.status).toBe("review");

    const advance = svc.calls.find((c: any) => c[0] === "updateReviewPhase");
    expect(advance).toEqual(["updateReviewPhase", ticket.id, "architecture", "ticket-watcher"]);
    // A qa PASS must NOT complete the ticket.
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);
  });

  it("completes the ticket on an architecture-phase PASS (does not re-phase)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-pass-arch-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const ticket: any = {
      id: "t-pass-arch-" + Date.now(),
      title: "Arch pass ticket",
      description: "implement the feature",
      status: "review",
      reviewPhase: "architecture",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));
    const svc = makeStubService(ticket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-arch-pass-agent-1" }),
    });

    // Default architect rule fires on reviewPhaseChanged into architecture.
    bus.emit("ticket:reviewPhaseChanged", {
      ticketId: ticket.id,
      oldPhase: "qa",
      newPhase: "architecture",
      updatedBy: "ticket-watcher",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-arch-pass-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Matches the design docs and conventions.\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(ticket.status).toBe("done");

    const complete = svc.calls.find((c: any) => c[0] === "completeTicket");
    expect(complete).toEqual([
      "completeTicket",
      ticket.id,
      "Approved by automated review pipeline.",
      "ticket-watcher",
    ]);
    // An architecture PASS must NOT advance the reviewPhase any further.
    expect(svc.calls.some((c: any) => c[0] === "updateReviewPhase")).toBe(false);
  });
});
