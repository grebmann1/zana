// Covers two executeStep branches not exercised by the existing suite:
//   • "wait" step — awaits a capped setTimeout; fake timers make it instant
//   • default/unknown action — returns { error: "unknown action: <x>" };
//     the run still reaches "completed" because the error is not a halt signal
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-wait-${Date.now()}-${process.pid}`,
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

describe("executeWorkflow — wait step", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    vi.useRealTimers();
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("completes with status='completed' and step result={ waited: <ms> }", async () => {
    const runPromise = executeWorkflow({
      id: "wait-basic",
      name: "Wait Basic",
      steps: [{ action: "wait", durationMs: 5000 }],
    });

    // Advance fake timers past the wait duration so the setTimeout resolves.
    await vi.runAllTimersAsync();

    const run = await runPromise;
    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[0].result).toMatchObject({ waited: 5000 });
  });

  it("caps durationMs at 30 000 ms (MAX)", async () => {
    const runPromise = executeWorkflow({
      id: "wait-capped",
      name: "Wait Capped",
      steps: [{ action: "wait", durationMs: 999_999 }],
    });

    await vi.runAllTimersAsync();

    const run = await runPromise;
    // The wait duration is capped at 30 000 ms in the source.
    expect(run.steps[0].result).toMatchObject({ waited: 30_000 });
  });

  it("defaults durationMs to 5 000 ms when omitted", async () => {
    const runPromise = executeWorkflow({
      id: "wait-default",
      name: "Wait Default",
      steps: [{ action: "wait" }],
    });

    await vi.runAllTimersAsync();

    const run = await runPromise;
    expect(run.steps[0].result).toMatchObject({ waited: 5_000 });
  });
});

describe("executeWorkflow — unknown action (default branch)", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("records error in step result but run still reaches 'completed'", async () => {
    const run = await executeWorkflow({
      id: "unknown-action",
      name: "Unknown Action",
      steps: [{ action: "teleport" }],
    });

    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[0].result).toMatchObject({ error: "unknown action: teleport" });
  });

  it("continues executing subsequent steps after an unknown action step", async () => {
    const run = await executeWorkflow({
      id: "unknown-then-gate",
      name: "Unknown Then Gate",
      steps: [
        { action: "frobnicate" },            // unknown — returns error but does NOT halt
        { action: "gate", condition: "true" }, // should still run
      ],
    });

    expect(run.status).toBe("completed");
    expect(run.steps[0].result).toMatchObject({ error: "unknown action: frobnicate" });
    expect(run.steps[1].status).toBe("completed");
    expect(run.steps[1].result).toMatchObject({ passed: true });
  });
});
