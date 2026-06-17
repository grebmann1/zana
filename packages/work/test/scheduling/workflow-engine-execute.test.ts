// executeWorkflow unit tests — guard invariants and gate step execution.
// The existing workflow-engine.test.ts covers evaluateCondition, constants,
// loadRun, and listRuns; this file covers the executeWorkflow() orchestrator.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import {
  executeWorkflow,
  loadRun,
  MAX_STEPS,
} from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-exec-${Date.now()}-${process.pid}`,
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

// ─────────────────────────────────────────────────────────────────────────────
// Guard invariants — no workspace or mocks needed (early returns before I/O)
// ─────────────────────────────────────────────────────────────────────────────

describe("executeWorkflow — guard invariants", () => {
  it("returns { error: 'no_steps' } when skill has no steps", async () => {
    const result = await executeWorkflow({ id: "s1", name: "Empty", steps: [] });
    expect(result).toEqual({ error: "no_steps" });
  });

  it("returns { error: 'too_many_steps' } when step count exceeds MAX_STEPS", async () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ action: "gate", condition: "true" }));
    const result = await executeWorkflow({ id: "s2", name: "Bloated", steps });
    expect(result).toEqual({ error: "too_many_steps" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate step — tests the step-execution loop without spawning real agents
// ─────────────────────────────────────────────────────────────────────────────

describe("executeWorkflow — gate step", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("completes successfully when all gate conditions pass", async () => {
    const run = await executeWorkflow({
      id: "gate-pass",
      name: "Gate Pass",
      steps: [{ action: "gate", condition: "1 === 1" }],
    });
    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    expect(run.completedAt).toBeTruthy();
  });

  it("halts immediately when a gate condition fails", async () => {
    const run = await executeWorkflow({
      id: "gate-fail",
      name: "Gate Fail",
      steps: [
        { action: "gate", condition: "false" },
        { action: "gate", condition: "true" },  // must NOT run
      ],
    });
    expect(run.status).toBe("halted");
    expect(run.steps[0].status).toBe("halted");
    expect(run.steps[0].result).toMatchObject({ halted: true });
    // Second step should remain "pending" — execution stopped at step 0.
    expect(run.steps[1].status).toBe("pending");
  });

  it("persists the completed run to disk so loadRun can retrieve it", async () => {
    const run = await executeWorkflow({
      id: "gate-persist",
      name: "Gate Persist",
      steps: [{ action: "gate", condition: "true" }],
    });
    const loaded = loadRun(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded.id).toBe(run.id);
    expect(loaded.status).toBe("completed");
  });
});
