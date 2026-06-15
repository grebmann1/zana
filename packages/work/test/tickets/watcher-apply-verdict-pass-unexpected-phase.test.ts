// Tests the applyVerdict PASS path's `else` guard in watcher.ts (lines 597-599):
//
//   if (verdict.kind === "PASS") {
//     if (ticket.reviewPhase === "qa") { ...advance... }
//     else if (ticket.reviewPhase === "architecture") { ...complete... }
//     else { log("Unexpected reviewPhase ... on PASS ..."); }   // <- under test
//   }
//
// The qa and architecture PASS branches each have a dedicated test
// (watcher-apply-verdict-pass.test.ts). The fall-through guard — a PASS verdict
// arriving for a ticket whose reviewPhase is neither qa nor architecture — was
// untested. This is a safety branch: a stray/duplicate PASS must NOT advance the
// phase or complete the ticket. It should only record the audit comment and
// leave ticket state untouched.
//
// Driven through the REAL bus sequence (rule fire -> spawn -> agent:terminated
// with "VERDICT: PASS"). No real Claude, no real SQLite, no real spawns.

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

describe("applyVerdict — PASS on an unexpected reviewPhase is a no-op (audit comment only)", () => {
  it("records the comment but does not advance the phase or complete the ticket", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-pass-unexpected-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    // A custom rule that fires on any status change into "review" without
    // requiring a reviewPhase, so we can drive a PASS verdict for a ticket whose
    // reviewPhase is null (neither qa nor architecture).
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        automation: [
          {
            name: "review-any-phase",
            trigger: { event: "ticket:statusChanged", to: "review" },
            action: { spawnProfile: "code-reviewer" },
            promptTemplate: "Review {{id}}",
          },
        ],
      }),
      "utf8",
    );

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const ticket: any = {
      id: "t-pass-unexpected-" + Date.now(),
      title: "PASS with no review phase",
      description: "implement the feature",
      status: "review",
      reviewPhase: null, // <- neither "qa" nor "architecture"
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "coder",
    };

    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));
    const svc = makeStubService(ticket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath,
      spawnAgent: () => Promise.resolve({ agentId: "fake-pass-unexpected-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: ticket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-pass-unexpected-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Looks fine to me.\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    // State is untouched: still review/null, not advanced, not completed.
    expect(ticket.status).toBe("review");
    expect(ticket.reviewPhase).toBe(null);

    // The audit comment IS still recorded (the PASS was observed).
    expect(svc.calls.some((c: any) => c[0] === "addComment")).toBe(true);

    // No phase advance and no completion for a PASS outside qa/architecture.
    expect(svc.calls.some((c: any) => c[0] === "updateReviewPhase")).toBe(false);
    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(false);
  });
});
