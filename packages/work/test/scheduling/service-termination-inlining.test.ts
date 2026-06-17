// Tests the AGENT_TERMINATED result-inlining path of the scheduler service.
//
// A spawn-agent fire is non-blocking: the run-history entry is appended with a
// `finalStatus: "pending"` stub and the agentId is tracked in the inflight map.
// When the agent later terminates, attachTerminationListener (wired here via the
// _ensureBusListenerForTest seam with a fake bus) patches the SAME history entry
// with the result summary and a finalStatus derived from the exit code:
//   exitCode === 0  ⇒ "success"
//   anything else   ⇒ "error"  (conservative — a killed/crashed agent is an error)
// and removes the inflight tracking entry.
//
// This behavior had no coverage despite being claimed in service.test.ts's header.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";
import * as schedulerStore from "@zana-ai/work/src/scheduling/store.ts";

// Minimal fake of the core event bus: just enough surface (on/emit) for the
// termination listener. No real Claude, no real agent manager.
function makeFakeBus() {
  const handlers: Record<string, Array<(evt: any) => void>> = {};
  return {
    on(name: string, fn: (evt: any) => void) {
      (handlers[name] ||= []).push(fn);
    },
    emit(name: string, evt: any) {
      (handlers[name] || []).forEach((h) => h(evt));
    },
  };
}

describe("scheduler service — agent-termination result inlining", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-term-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
    // Drain any inflight entries leaked from prior tests in this module.
    for (const e of (schedulerService as any)._getInflightAgentsForTest()) {
      (schedulerService as any)._trackAgentForTest(e.agentId, e.scheduleId, 0);
    }
    schedulerService.sweepInflightAgents();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  function makeScheduleWithPendingEntry(name: string, agentId: string): string {
    const created = schedulerService.createSchedule({
      name,
      every: "5m",
      action: { type: "command", argv: ["echo", "ok"] },
      enabled: false, // don't start a real trigger
    });
    const id = (created as any).id as string;
    // Mirror what triggerSchedule does for a spawn-agent fire.
    (schedulerService as any)._trackAgentForTest(agentId, id);
    schedulerStore.appendRunResult(id, {
      status: "success",
      actionType: "spawn-agent",
      agentId,
      finalStatus: "pending",
      summary: "",
    });
    return id;
  }

  // One bus, one listener: busSubscribed is module-level, so a second
  // _ensureBusListenerForTest call would be a silent no-op. Exercise every
  // branch (success / non-zero-exit / untracked) through a single fake bus.
  it("derives finalStatus from exit code, inlines summary, clears inflight, and ignores untracked agents", () => {
    const okId = makeScheduleWithPendingEntry("term-ok", "agent-ok");
    const failId = makeScheduleWithPendingEntry("term-fail", "agent-fail");
    const untouchedId = makeScheduleWithPendingEntry("term-untouched", "agent-tracked");

    const bus = makeFakeBus();
    schedulerService._ensureBusListenerForTest(bus, "agent:terminated");

    // Clean exit → success, output inlined as the summary.
    bus.emit("agent:terminated", { agentId: "agent-ok", exitCode: 0, output: "all done" });
    // Non-zero exit (e.g. SIGKILL/timeout) → error, conservatively.
    bus.emit("agent:terminated", { agentId: "agent-fail", exitCode: 137, output: "killed" });
    // An unrelated agent terminates — must not touch any of our pending entries.
    bus.emit("agent:terminated", { agentId: "some-stranger", exitCode: 0, output: "x" });

    const okEntry = schedulerStore.getRunHistory(okId).at(-1);
    expect(okEntry.finalStatus).toBe("success");
    expect(okEntry.summary).toBe("all done");

    const failEntry = schedulerStore.getRunHistory(failId).at(-1);
    expect(failEntry.finalStatus).toBe("error");
    expect(failEntry.summary).toBe("killed");

    // The untracked termination left this pending entry untouched.
    const untouchedEntry = schedulerStore.getRunHistory(untouchedId).at(-1);
    expect(untouchedEntry.finalStatus).toBe("pending");
    expect(untouchedEntry.summary).toBe("");

    // Tracked inflight entries are consumed once their termination is processed;
    // the untracked one (agent-tracked) was never terminated, so it remains.
    const inflight = (schedulerService as any)._getInflightAgentsForTest();
    expect(inflight.find((e: any) => e.agentId === "agent-ok")).toBeUndefined();
    expect(inflight.find((e: any) => e.agentId === "agent-fail")).toBeUndefined();
    expect(inflight.find((e: any) => e.agentId === "agent-tracked")).toBeDefined();
  });
});
