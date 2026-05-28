// zana_deliberate_cancel tests.
//
// Covers:
//   - Cancel a running deliberation → kills voter agents, lands EXHAUSTED
//   - Cancel an already-terminal deliberation → _alreadyTerminal=true, no-op
//   - Cancel a deliberation not tracked in this process (orphan) → best-effort
//     transition + _orphan=true
//   - Validation errors (missing/empty deliberationId, unknown id)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";
const work = require("@zana/work");
const checkpointStore = work.runs.checkpoint.store;
const run = work.deliberation;

import {
  deliberateHandler,
  deliberationStatusHandler,
  deliberationCancelHandler,
  _getActiveRunsForTest,
  type DeliberateDeps,
} from "../../src/tools/deliberate.ts";

function profileFor(id: string) {
  return { id, displayName: id, model: "claude-sonnet-4-6", description: `lens ${id}` };
}

function fakeProbe() {
  return async (profile: any) => ({
    ok: true, latencyMs: 1, failures: [], modelId: profile.model,
    probeId: `p-${profile.id}`, legs: [],
  });
}

/**
 * Slow agent fake — agents stay in `running` state until released, so the
 * orchestration loop blocks inside collectReviews until cancel kicks in.
 */
function slowAgentPair() {
  let nextId = 0;
  const agents = new Map<string, any>();
  const killCalls: string[] = [];
  return {
    spawnHeadlessAgent: (profile: any) => {
      const id = `slow-${profile.id}-${++nextId}`;
      agents.set(id, { id, profileId: profile.id, state: "running", outputBuffer: "" });
      return { agentId: id, terminalId: `t-${id}` };
    },
    getAgent: (id: string) => agents.get(id) ?? null,
    killAgent: (id: string) => {
      killCalls.push(id);
      const a = agents.get(id);
      if (a) {
        // Killing flips the agent to terminated so collectReviews polls
        // observe a terminal state and wrap up.
        a.state = "terminated";
        a.result = '{"bit":"CHANGES","rationale":"[killed]"}';
        a.outputBuffer = a.result;
      }
      return true;
    },
    _killCalls: killCalls,
    _agents: agents,
  };
}

describe("zana_deliberate_cancel", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-cancel-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("rejects missing deliberationId", () => {
    expect(() => deliberationCancelHandler({} as any)).toThrow(/deliberationId is required/);
    expect(() => deliberationCancelHandler({ deliberationId: "" })).toThrow(/deliberationId is required/);
  });

  it("rejects unknown deliberationId", () => {
    expect(() => deliberationCancelHandler({ deliberationId: "nonexistent" })).toThrow(/deliberation not found/);
  });

  it("cancels a running deliberation: kills voters, lands EXHAUSTED, returns _outcome=cancelling", async () => {
    const pair = slowAgentPair();
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 5,
      timeoutMs: 60000, // big timeout — cancel must fire before this
      maxIterations: 32,
    };

    // Kick off async — voter agents will be stuck in `running` until killed.
    const stub = await deliberateHandler({
      question: "cancel-while-running",
      voters: ["a", "b", "c"],
      rounds: 1,
      deps,
    });
    expect(stub.state).toBe("PROPOSED");
    expect(stub._async).toBe(true);

    // Wait until at least one voter is spawned and tracked.
    const start = Date.now();
    while (Date.now() - start < 1000) {
      if (pair._agents.size > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pair._agents.size).toBeGreaterThan(0);

    // Now cancel.
    const cancelResult = deliberationCancelHandler({ deliberationId: stub.id });
    expect(cancelResult._outcome).toBe("cancelling");
    expect(cancelResult._killedAgents).toBeGreaterThan(0);

    // Wait for the runner to land EXHAUSTED / SETTLED / ESCALATED.
    let final: any = null;
    for (let i = 0; i < 200; i++) {
      const s = deliberationStatusHandler({ deliberationId: stub.id });
      if (s.state === "EXHAUSTED" || s.state === "SETTLED" || s.state === "ESCALATED") {
        final = s;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(final).not.toBeNull();
    // Cancellation can land EXHAUSTED (CONVERGING→EXHAUSTED legal) or
    // ESCALATED (REVIEWING→ESCALATED→ ... fallback). Accept either as
    // long as it's a deliberate-cancel terminal.
    expect(["EXHAUSTED", "ESCALATED"]).toContain(final.state);

    // The activeRuns map must be cleared after the run finishes.
    expect(_getActiveRunsForTest().some((r) => r.deliberationId === stub.id)).toBe(false);
  });

  it("cancel on an already-SETTLED deliberation is a no-op (returns _alreadyTerminal=true)", async () => {
    // Run a quick deliberation to completion using fast voters.
    const fastAgents = (() => {
      let id = 0;
      const agents = new Map<string, any>();
      return {
        spawnHeadlessAgent: (profile: any) => {
          const aid = `fast-${profile.id}-${++id}`;
          agents.set(aid, {
            id: aid, profileId: profile.id, state: "terminated",
            result: '{"bit":"APPROVE","rationale":"ok"}',
            outputBuffer: '{"bit":"APPROVE","rationale":"ok"}',
          });
          return { agentId: aid };
        },
        getAgent: (aid: string) => agents.get(aid) ?? null,
        killAgent: () => true,
      };
    })();
    const deps: DeliberateDeps = {
      probeAgent: fakeProbe(),
      spawnHeadlessAgent: fastAgents.spawnHeadlessAgent,
      getAgent: fastAgents.getAgent,
      killAgent: fastAgents.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };
    const final = await deliberateHandler({
      question: "settle-fast",
      voters: ["a", "b", "c"],
      rounds: 1,
      wait: true,
      deps,
    });
    expect(final.state).toBe("SETTLED");

    const cancelResult = deliberationCancelHandler({ deliberationId: final.id });
    expect(cancelResult._alreadyTerminal).toBe(true);
    expect(cancelResult.state).toBe("SETTLED");
  });

  it("cancel an orphan deliberation (no live tracker) → best-effort transition + _orphan=true", () => {
    // Create a deliberation directly via run.propose(), bypassing the handler.
    // Without a kicked-off background runner, no activeRuns entry exists.
    const proposed = run.propose({
      question: "orphan-cancel",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      rounds: 1,
      promptSnapshot: "snap",
    });
    expect(proposed.state).toBe("PROPOSED");

    const result = deliberationCancelHandler({ deliberationId: proposed.id });
    expect(result._outcome).toBe("cancelled");
    expect(result._orphan).toBe(true);
    // PROPOSED → EXHAUSTED is legal, so the orphan path lands EXHAUSTED cleanly.
    expect(result.state).toBe("EXHAUSTED");
  });
});
