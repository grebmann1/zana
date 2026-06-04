// Tests for applyVerdict state-transition paths in watcher.ts that are NOT
// covered by watcher-pure.test.ts (pure helpers) or watcher-validate.test.ts
// (rule loading). Exercises the PASS/architecture → completeTicket path and
// the no-verdict → warning-comment path via the test hooks exposed by the
// module (_setServiceOverride, _setReadTicketOverride, _resetDedup).
//
// No real Claude, no real SQLite, no real spawns — all I/O is faked.
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

describe("applyVerdict — PASS in architecture phase → completeTicket", () => {
  it("calls completeTicket when a PASS arrives for a ticket in architecture review", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-arch-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-arch-" + Date.now(),
      title: "Arch PASS test",
      description: "",
      status: "review",
      reviewPhase: "architecture",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "architect",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-arch-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-arch-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Architecture matches design docs.\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(fakeTicket.status).toBe("done");
    const complete = svc.calls.find((c: any) => c[0] === "completeTicket");
    expect(complete).toBeTruthy();
    expect(complete[1]).toBe(fakeTicket.id);
    expect(complete[3]).toBe("ticket-watcher");
  });
});

describe("applyVerdict — no verdict line → adds warning comment", () => {
  it("adds a comment and leaves ticket state unchanged when agent output has no VERDICT", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-noverd-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const fakeTicket: any = {
      id: "t-noverd-" + Date.now(),
      title: "No Verdict test",
      description: "",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "code-reviewer",
    };

    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));
    const svc = makeStubService(fakeTicket);
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-noverd-agent-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-noverd-agent-1",
      reason: "completed",
      exitCode: 0,
      output: "Looks good overall, nothing critical found.",
    });
    await new Promise((r) => setTimeout(r, 20));

    // Status must remain unchanged — no state transition without a verdict.
    expect(fakeTicket.status).toBe("review");
    expect(fakeTicket.reviewPhase).toBe("qa");

    // A warning comment must have been added.
    const comment = svc.calls.find((c: any) => c[0] === "addComment");
    expect(comment).toBeTruthy();
    expect(comment[4]).toMatch(/VERDICT/i);
    expect(svc.calls.some((c: any) => c[0] === "updateStatus" || c[0] === "completeTicket")).toBe(false);
  });
});
