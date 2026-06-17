// Tests the #4 STRUCTURED verdict path: a reviewer calls zana_ticket_verdict
// → service.recordVerdict emits "ticket:verdict" → the watcher applies the same
// PASS/FAIL/READY/BLOCKED transition it would from a parsed VERDICT: line.
//
// Also asserts the dedup contract: when a structured verdict has been recorded,
// the agent:terminated TEXT-fallback must NOT re-apply (no double transition).
//
// Real bus, stubbed ticket service (so transitions are observable without
// SQLite). No real Claude / spawns.

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

async function setup(ticket: any) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-structured-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const configPath = path.join(tmpDir, "config.json");

  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  const bus = (await import("@zana-ai/core") as any).events.bus;

  watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));
  const svc = makeStubService(ticket);
  watcher._setServiceOverride(svc);
  watcher.init({
    ticketsDirectory: ticketsDir,
    configPath,
    spawnAgent: () => Promise.resolve({ agentId: "agent-x" }),
  });
  return { bus, svc };
}

describe("structured verdict path (#4)", () => {
  it("a PASS verdict in qa phase advances to architecture", async () => {
    const ticket: any = { id: "t-sv-pass-" + Date.now(), title: "x", status: "review", reviewPhase: "qa", labels: [], reworkCount: 0 };
    const { bus, svc } = await setup(ticket);

    bus.emit("ticket:verdict", { ticketId: ticket.id, kind: "PASS", reason: null, profileLabel: "code-reviewer" });
    await new Promise((r) => setTimeout(r, 20));

    expect(svc.calls.some((c: any) => c[0] === "updateReviewPhase" && c[2] === "architecture")).toBe(true);
    expect(ticket.reviewPhase).toBe("architecture");
  });

  it("a FAIL verdict sends the ticket to rework", async () => {
    const ticket: any = { id: "t-sv-fail-" + Date.now(), title: "x", status: "review", reviewPhase: "qa", labels: [], reworkCount: 0 };
    const { bus, svc } = await setup(ticket);

    bus.emit("ticket:verdict", { ticketId: ticket.id, kind: "FAIL", reason: "null deref in handler", profileLabel: "code-reviewer" });
    await new Promise((r) => setTimeout(r, 20));

    expect(svc.calls.some((c: any) => c[0] === "updateStatus" && c[2] === "rework")).toBe(true);
    // The reason is captured in the audit comment.
    const comment = svc.calls.find((c: any) => c[0] === "addComment");
    expect(JSON.stringify(comment)).toContain("null deref in handler");
  });

  it("lowercase kind is normalized (pass → PASS)", async () => {
    const ticket: any = { id: "t-sv-lc-" + Date.now(), title: "x", status: "review", reviewPhase: "architecture", labels: [], reworkCount: 0 };
    const { bus, svc } = await setup(ticket);

    bus.emit("ticket:verdict", { ticketId: ticket.id, kind: "pass", reason: null });
    await new Promise((r) => setTimeout(r, 20));

    expect(svc.calls.some((c: any) => c[0] === "completeTicket")).toBe(true);
  });

  it("text-fallback does NOT double-apply after a structured verdict for the same ticket", async () => {
    const ticket: any = { id: "t-sv-dedup-" + Date.now(), title: "x", status: "review", reviewPhase: "qa", labels: [], reworkCount: 0 };
    const { bus, svc } = await setup(ticket);

    // First: the structured verdict arrives and advances to architecture.
    bus.emit("ticket:verdict", { ticketId: ticket.id, kind: "PASS", reason: null });
    await new Promise((r) => setTimeout(r, 20));
    const phaseAdvancesAfterStructured = svc.calls.filter((c: any) => c[0] === "updateReviewPhase").length;
    expect(phaseAdvancesAfterStructured).toBe(1);

    // Now simulate the SAME reviewer agent terminating with a VERDICT: PASS line
    // (it both called the tool AND ended with the legacy line). The watcher must
    // have tracked it (expectVerdict default true) — but the structured-seen
    // guard must suppress the second application.
    watcher._trackForTest("agent-dup", ticket, { action: { spawnProfile: "code-reviewer", expectVerdict: true } });
    bus.emit("agent:terminated", { agentId: "agent-dup", reason: "completed", exitCode: 0, output: "looks good\nVERDICT: PASS" });
    await new Promise((r) => setTimeout(r, 20));

    // Still exactly ONE phase advance — the text path was suppressed.
    const totalPhaseAdvances = svc.calls.filter((c: any) => c[0] === "updateReviewPhase").length;
    expect(totalPhaseAdvances).toBe(1);
  });
});
