// executeWorkflow — max_concurrent_runs runtime guard.
//
// The existing workflow-engine.test.ts only checks that MAX_CONCURRENT_RUNS is
// a positive integer.  It does NOT exercise the runtime guard at the top of
// executeWorkflow():
//
//   if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
//     return { error: "max_concurrent_runs" };
//   }
//
// This file verifies the guard actually fires when the cap is saturated.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  executeWorkflow,
  MAX_CONCURRENT_RUNS,
} from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-concur-${Date.now()}-${process.pid}`,
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A skill with a single wait step — keeps the run in-flight until timers fire. */
function slowSkill(id: string) {
  return {
    id,
    name: `Slow-${id}`,
    // Use MAX 30 000 ms so the wait step gets capped and stays paused
    // under fake timers until we call vi.runAllTimersAsync().
    steps: [{ action: "wait", durationMs: 60_000 }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("executeWorkflow — max_concurrent_runs guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(async () => {
    // Drain any lingering timers so activeRuns is clean for the next test.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("returns { error: 'max_concurrent_runs' } when the concurrency cap is saturated", async () => {
    // Launch MAX_CONCURRENT_RUNS workflows without awaiting them.
    //
    // Each executeWorkflow() call runs synchronously up to the first `await`
    // (the wait step's setTimeout), so each one adds itself to `activeRuns`
    // before control returns here — no microtask boundary needed.
    const running = Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) =>
      executeWorkflow(slowSkill(`concur-${i}`)),
    );

    // activeRuns.size === MAX_CONCURRENT_RUNS at this point.
    // The next call must be rejected immediately.
    const overflow = await executeWorkflow(slowSkill("overflow"));

    expect(overflow).toEqual({ error: "max_concurrent_runs" });

    // Drain running workflows so activeRuns is empty before afterEach.
    await vi.runAllTimersAsync();
    await Promise.all(running);
  });

  it("accepts a new workflow once a previously active run completes", async () => {
    // Fill up to the cap.
    const running = Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) =>
      executeWorkflow(slowSkill(`fill-${i}`)),
    );

    // Guard fires — cap is full.
    const rejected = await executeWorkflow(slowSkill("rejected"));
    expect(rejected).toEqual({ error: "max_concurrent_runs" });

    // Complete all running workflows by advancing fake timers.
    await vi.runAllTimersAsync();
    await Promise.all(running);

    // activeRuns is now empty — a new workflow should be accepted.
    const accepted = executeWorkflow(slowSkill("accepted"));
    await vi.runAllTimersAsync();
    const result = await accepted;

    expect(result.status).toBe("completed");
  });
});
