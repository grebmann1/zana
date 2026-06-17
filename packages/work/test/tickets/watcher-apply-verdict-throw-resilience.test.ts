// Resilience of the agent:terminated handler in watcher.ts (lines 180-184):
//
//   try {
//     applyVerdict(tracked.ticket, tracked.rule, result);
//   } catch (err: any) {
//     log(`applyVerdict failed for ticket ${tracked.ticket.id}: ...`);
//   }
//
// A verdict whose underlying ticket-service call throws must NOT crash the
// watcher or leave it wedged: the error is caught + logged, the in-flight
// spawn is dropped, and a SUBSEQUENT good verdict for another ticket still
// applies its full transition.
//
// Covered behaviours:
//   • A throwing service during applyVerdict is swallowed (no rejection escapes)
//   • The watcher remains running afterwards (isRunning() stays true)
//   • The failed ticket is left untouched (no partial transition)
//   • A later, well-behaved verdict on a different ticket still advances it
//
// Uses the `_trackForTest` seam to drive the agent:terminated path directly,
// so there is no real spawn, no real Claude, and no real SQLite store.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let watcher: any = null;
let tmpDir: string | null = null;

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

describe("applyVerdict — throwing service is caught and the watcher survives", () => {
  it("swallows a verdict whose service throws, stays running, and applies the next good verdict", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-throw-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    const badTicket: any = {
      id: "t-throw-bad", title: "boom", description: "d",
      status: "review", reviewPhase: "qa", labels: [], reworkCount: 0,
    };
    const goodTicket: any = {
      id: "t-throw-good", title: "ok", description: "d",
      status: "review", reviewPhase: "qa", labels: [], reworkCount: 0,
    };

    const calls: any[] = [];
    const svc = {
      calls,
      getTicket: (id: string) =>
        id === badTicket.id ? badTicket : id === goodTicket.id ? goodTicket : null,
      addComment: (id: string, ...rest: any[]) => {
        calls.push(["addComment", id, ...rest]);
        // The bad ticket's first service write blows up mid-applyVerdict.
        if (id === badTicket.id) throw new Error("simulated store failure");
        return { ok: true };
      },
      updateReviewPhase: (id: string, phase: string, actor: string) => {
        calls.push(["updateReviewPhase", id, phase, actor]);
        if (id === goodTicket.id) goodTicket.reviewPhase = phase;
        return { ok: true };
      },
      updateStatus: (id: string, status: string, actor: string) => {
        calls.push(["updateStatus", id, status, actor]);
        return { ok: true };
      },
      completeTicket: (id: string, summary: string, actor: string) => {
        calls.push(["completeTicket", id, summary, actor]);
        return { ok: true };
      },
    };

    watcher._setReadTicketOverride((id: string) => svc.getTicket(id));
    watcher._setServiceOverride(svc);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "unused" }),
    });
    expect(watcher.isRunning()).toBe(true);

    const rule = { action: { spawnProfile: "code-reviewer", expectVerdict: true } };

    // 1) A verdict that makes the service throw. Must not crash the watcher.
    watcher._trackForTest("agent-bad", badTicket, rule);
    expect(() =>
      bus.emit("agent:terminated", {
        agentId: "agent-bad", reason: "completed", exitCode: 0,
        output: "issues everywhere\nVERDICT: FAIL — kaboom",
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    // The watcher absorbed the failure and is still subscribed.
    expect(watcher.isRunning()).toBe(true);
    // The throw happened at addComment, before any status transition — the
    // ticket is left exactly as it was.
    expect(badTicket.status).toBe("review");
    expect(badTicket.reviewPhase).toBe("qa");
    expect(calls.some((c) => c[0] === "updateStatus" && c[1] === badTicket.id)).toBe(false);

    // 2) A subsequent well-behaved verdict for a different ticket still applies.
    watcher._trackForTest("agent-good", goodTicket, rule);
    bus.emit("agent:terminated", {
      agentId: "agent-good", reason: "completed", exitCode: 0,
      output: "looks great\nVERDICT: PASS",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(goodTicket.reviewPhase).toBe("architecture");
    expect(
      calls.some((c) => c[0] === "updateReviewPhase" && c[1] === goodTicket.id && c[2] === "architecture"),
    ).toBe(true);
  });
});
