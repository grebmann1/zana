// Tests the run-level FAILURE path of executeWorkflow (workflow-engine.ts
// lines 135-141): when a step throws an uncaught exception inside the
// execution loop, the orchestrator's try/catch must mark the whole run
// status="failed", record run.error, stamp completedAt, persist, and emit
// "workflow:failed".
//
// Every other workflow-engine suite drives only the "completed" and "halted"
// outcomes — the existing notify-invalid-payload test exercises the *inner*
// JSON.parse catch (raw fallback) but never lets an exception escape
// executeStep. This file covers the distinct OUTER catch.
//
// Trigger: a "spawn" step whose profile resolves but whose
// agentManager.spawnHeadlessAgent() throws. The throw is raised from a core
// service call inside executeStep (not from data embedded in the run object,
// which would break the pre-loop persistRun before the try is even entered),
// so it propagates cleanly to executeWorkflow's catch. No real agent is
// spawned and no network/Claude is touched — the spawn call is stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { executeWorkflow, loadRun } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-failed-${Date.now()}-${process.pid}`,
);

const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}
function initWorkspace(root: string) {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { wc.init(root); } catch {}
  }
}

const agents: any = (core as any).agents;
const SPAWN_ERROR = "spawn boom (test)";

describe("executeWorkflow — run fails when a step throws", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
    // Profile resolves (so we get past the not-found early return)…
    vi.spyOn(agents.profileStore, "getProfile").mockReturnValue({ id: "p1", name: "P1" } as any);
    // …but the actual spawn throws, exercising the outer catch in executeWorkflow.
    vi.spyOn(agents.manager, "spawnHeadlessAgent").mockImplementation(() => {
      throw new Error(SPAWN_ERROR);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  const spawnStep = { action: "spawn", profileId: "p1", prompt: "hi" };

  it("marks the run status='failed', records the error, and emits workflow:failed", async () => {
    const bus = (core as any).events.bus;
    let failedEvent: any = null;
    const handler = (e: any) => { failedEvent = e; };
    bus.once("workflow:failed", handler);

    let run: any;
    try {
      run = await executeWorkflow({ id: "wf-throws", name: "Throwing Workflow", steps: [spawnStep] });
    } finally {
      bus.off("workflow:failed", handler);
    }

    // Run-level outcome: the exception was caught, not propagated.
    expect(run.status).toBe("failed");
    expect(run.error).toBe(SPAWN_ERROR);
    expect(run.completedAt).toBeTruthy();

    // The throwing step never advanced past "running".
    expect(run.steps[0].status).toBe("running");

    // The failure event fired with the run id and matching error.
    expect(failedEvent).not.toBeNull();
    expect(failedEvent.runId).toBe(run.id);
    expect(failedEvent.error).toBe(SPAWN_ERROR);
  });

  it("persists the failed run to disk so loadRun reports status='failed'", async () => {
    const run: any = await executeWorkflow({
      id: "wf-throws-persist",
      name: "Throwing Workflow Persist",
      steps: [spawnStep],
    });

    const loaded = loadRun(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded.status).toBe("failed");
    expect(loaded.error).toBe(SPAWN_ERROR);
  });

  it("stops the loop at the throwing step — later steps stay pending", async () => {
    const run: any = await executeWorkflow({
      id: "wf-throws-halts-loop",
      name: "Throwing Workflow Halts Loop",
      steps: [
        spawnStep,
        { action: "gate", condition: "true" }, // must NOT run
      ],
    });

    expect(run.status).toBe("failed");
    expect(run.steps[1].status).toBe("pending");
  });
});
