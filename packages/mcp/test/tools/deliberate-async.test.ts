// zana_deliberate async-by-default tests.
//
// Verifies:
//   - Default (no `wait`) returns IMMEDIATELY with state=PROPOSED, _async=true
//   - The orchestration loop runs detached and reaches a terminal state
//   - zana_deliberation_status reflects progress while running
//   - Crashes in the background runner mark the deliberation ESCALATED so
//     polling callers don't get stuck
//   - activeRuns map is cleared after completion
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
const work = require("@zana-ai/work");
const checkpointStore = work.runs.checkpoint.store;
const run = work.deliberation;

import {
  deliberateHandler,
  deliberationStatusHandler,
  _getActiveRunsForTest,
  type DeliberateDeps,
} from "../../src/tools/deliberate.ts";

function profileFor(id: string, model = "claude-opus") {
  return { id, displayName: id, model, description: `lens ${id}` };
}

function fakeProbe() {
  return async (profile: any) => ({
    ok: true,
    latencyMs: 1,
    failures: [],
    modelId: profile.model,
    probeId: `p-${profile.id}`,
    legs: [],
  });
}

function fakeAgentPair(
  script: Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>,
) {
  let nextId = 0;
  const agents = new Map<string, any>();
  return {
    spawnHeadlessAgent: (profile: any) => {
      const id = `fake-${profile.id}-${++nextId}`;
      const cell = script[profile.id];
      const result = cell ? JSON.stringify(cell) : JSON.stringify({ bit: "CHANGES", rationale: "?" });
      agents.set(id, { id, profileId: profile.id, state: "terminated", result, outputBuffer: result });
      return { agentId: id, terminalId: `t-${id}` };
    },
    getAgent: (id: string) => agents.get(id) ?? null,
    killAgent: (id: string) => agents.delete(id),
  };
}

/** Wait for a deliberation to reach a terminal state, polling status. */
async function waitForTerminal(deliberationId: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = deliberationStatusHandler({ deliberationId });
    if (d.state === "SETTLED" || d.state === "ESCALATED" || d.state === "EXHAUSTED") {
      return d;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitForTerminal: ${deliberationId} did not terminate within ${timeoutMs}ms`);
}

describe("zana_deliberate — async by default", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-async-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("returns immediately with PROPOSED state and _async=true", async () => {
    const pair = fakeAgentPair({
      a: { bit: "APPROVE", rationale: "ok" },
      b: { bit: "APPROVE", rationale: "ok" },
      c: { bit: "APPROVE", rationale: "ok" },
    });
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };

    const t0 = Date.now();
    const result = await deliberateHandler({
      question: "async-by-default",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });
    const dt = Date.now() - t0;

    // Must return quickly — even with the orchestration loop scheduled, the
    // sync setup is just propose() + a setImmediate-ish kickoff.
    expect(dt).toBeLessThan(200);
    expect(result.state).toBe("PROPOSED");
    expect(result._async).toBe(true);
    expect(result._outcome).toBe("running");
    expect(result.id).toBeTruthy();
  });

  it("orchestration loop completes in the background; status polling sees SETTLED", async () => {
    const pair = fakeAgentPair({
      a: { bit: "APPROVE", rationale: "ok" },
      b: { bit: "APPROVE", rationale: "ok" },
      c: { bit: "APPROVE", rationale: "ok" },
    });
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const stub = await deliberateHandler({
      question: "background-run",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });

    const final = await waitForTerminal(stub.id);
    expect(final.state).toBe("SETTLED");
    expect(final.verdict).toBe("approve");
    expect(final.votes).toHaveLength(3);
  });

  it("activeRuns is cleared after the background run completes", async () => {
    const pair = fakeAgentPair({
      a: { bit: "APPROVE", rationale: "ok" },
      b: { bit: "APPROVE", rationale: "ok" },
      c: { bit: "APPROVE", rationale: "ok" },
    });
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const stub = await deliberateHandler({
      question: "active-runs-cleanup",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });

    // Right after kickoff, the run is tracked.
    const liveImmediately = _getActiveRunsForTest().some((r) => r.deliberationId === stub.id);
    expect(liveImmediately).toBe(true);

    await waitForTerminal(stub.id);

    // After completion, the entry must be cleared.
    const liveAfter = _getActiveRunsForTest().some((r) => r.deliberationId === stub.id);
    expect(liveAfter).toBe(false);
  });

  it("spawn errors are absorbed by collectReviews (CHANGES with diagnostic) — terminates cleanly", async () => {
    // Real-world failure mode: the spawner throws. collectReviews catches it,
    // returns a CHANGES vote whose rationale captures the error. With
    // persistent CHANGES across all rounds the deliberation hits cap_exhausted
    // — terminal, no stuck state. This verifies the GRACEFUL path.
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: () => { throw new Error("simulated spawn crash"); },
      getAgent: () => null,
      killAgent: () => true,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const stub = await deliberateHandler({
      question: "spawn-failure-graceful",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });
    const final = await waitForTerminal(stub.id, 3000);
    expect(final.state).toBe("ESCALATED");
    // Could be cap_exhausted (round 1 got no CHANGES at all? actually CHANGES
    // because parse failure) or risk-tag-triggered. Just assert terminal.
    expect(final.escalationReason).toBeTruthy();
  });

  it("crash in background runner drives deliberation to ESCALATED (no stuck state)", async () => {
    // Force a real crash inside runDeliberationUnsafe by making probeAgent
    // throw synchronously (bypasses Promise.allSettled — assembleCouncil
    // expects async behavior). Throwing FROM the dep itself before await
    // surfaces up the call stack.
    const deps: DeliberateDeps = {
      probeAgent: (() => { throw new Error("synchronous probe crash"); }) as any,
      spawnHeadlessAgent: () => ({ agentId: "x" } as any),
      getAgent: () => null,
      killAgent: () => true,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const stub = await deliberateHandler({
      question: "crash-recovery",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });
    const final = await waitForTerminal(stub.id, 3000);
    expect(final.state).toBe("ESCALATED");
    expect(final.escalationReason).toBeTruthy();
  });

  it("wait=true still works (legacy path) — returns the final record directly", async () => {
    const pair = fakeAgentPair({
      a: { bit: "APPROVE", rationale: "ok" },
      b: { bit: "APPROVE", rationale: "ok" },
      c: { bit: "APPROVE", rationale: "ok" },
    });
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const result = await deliberateHandler({
      question: "wait-true",
      voters: ["a", "b", "c"],
      rounds: 1,
      wait: true,
      deps,
    });
    expect(result.state).toBe("SETTLED");
    expect(result._outcome).toBe("settled");
    // wait=true must NOT mark the result as async-stub
    expect(result._async).toBeUndefined();
  });

  it("invalid input throws synchronously (before any state is created)", async () => {
    await expect(deliberateHandler({ question: "" } as any)).rejects.toThrow(/question is required/);
    await expect(deliberateHandler({} as any)).rejects.toThrow(/question is required/);
    // Unknown profile must surface eagerly, not get buried inside the background runner.
    await expect(
      deliberateHandler({
        question: "test",
        voters: ["nonexistent-profile-xyz"],
        deps: {
          probeAgent: fakeProbe(),
          getProfile: () => null,
          spawnHeadlessAgent: () => ({ agentId: "x" } as any),
          getAgent: () => null,
          killAgent: () => true,
        },
      }),
    ).rejects.toThrow(/unknown profile/);
  });
});
