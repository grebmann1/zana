// Tests for the "spawn" action branch in executeStep (workflow-engine.ts lines 149-162).
//
// The three existing workflow-engine test files cover:
//   - evaluateCondition, loadRun, listRuns, guard invariants (workflow-engine.test.ts)
//   - gate step, persist-to-disk (workflow-engine-execute.test.ts)
//   - wait step, unknown action (workflow-engine-wait-unknown.test.ts)
//
// The "spawn" case has two untested paths:
//   1. The step-level condition guard fires when the spawn step's own condition
//      evaluates to false — the step halts immediately, matching the halted
//      path already tested for the "gate" action but entered here via "spawn".
//   2. profileStore.getProfile() returns null for an unknown profileId — the
//      step records { error: "profile not found: …" } but does NOT halt, so
//      the run still reaches status="completed".
//
// Both branches avoid any real agent spawn (no profileStore mock is needed for
// the "not found" case — the real core's profileStore.getProfile simply returns
// null for a synthetic id).  All tests are deterministic: real FS under a tmp
// workspace, no network, no real Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-spawn-${Date.now()}-${process.pid}`,
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

describe("executeWorkflow — spawn step: profile not found", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("records { error: 'profile not found: …' } in step result when profileId is unknown", async () => {
    // The real profileStore.getProfile() returns null for a synthetic id, which
    // exercises the early-return branch on line 157 of workflow-engine.ts.
    const run = await executeWorkflow({
      id: "spawn-no-profile",
      name: "Spawn No Profile",
      steps: [{ action: "spawn", profileId: "nonexistent-profile-zana-test" }],
    });

    expect(run.steps[0].result).toMatchObject({
      error: expect.stringContaining("profile not found"),
    });
    expect(run.steps[0].result.error).toContain("nonexistent-profile-zana-test");
  });

  it("run reaches status='completed' even when spawn step cannot find the profile", async () => {
    // A profile-not-found error is NOT a halt signal — the run must keep going.
    const run = await executeWorkflow({
      id: "spawn-no-profile-completes",
      name: "Spawn No Profile Completes",
      steps: [
        { action: "spawn", profileId: "ghost-profile-zana-test" },
        { action: "gate", condition: "true" },
      ],
    });

    expect(run.status).toBe("completed");
    // Second step must have executed (run was NOT halted by the spawn error).
    expect(run.steps[1].status).toBe("completed");
  });

  it("halts immediately when the spawn step's own condition evaluates to false", async () => {
    // Lines 150-152 of workflow-engine.ts: the spawn action has its own
    // condition guard that is distinct from the "gate" action.  When the
    // condition is false the step returns { halted: true } and the run halts
    // before even attempting the profile lookup.
    const run = await executeWorkflow({
      id: "spawn-condition-false",
      name: "Spawn Condition False",
      steps: [
        { action: "spawn", profileId: "any", condition: "false" },
        { action: "gate", condition: "true" }, // must NOT run
      ],
    });

    expect(run.status).toBe("halted");
    expect(run.steps[0].status).toBe("halted");
    expect(run.steps[0].result).toMatchObject({ halted: true });
    // Second step must remain pending — execution stopped at step 0.
    expect(run.steps[1].status).toBe("pending");
  });
});
