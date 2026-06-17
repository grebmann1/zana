// Focused test for the "deliberation disappeared during retry" branch of
// applyDecision (round-controller.ts ~lines 194-199).
//
// The OCC retry loop only enters the reload path after applyOnce() throws a
// StaleDeliberationError. Normally the reload returns the fresh record and the
// decision is recomputed. But if a competing actor DELETES the deliberation
// between the stale write and the reload, loadDeliberation() returns null and
// applyDecision MUST surface an unrecoverable error rather than dereferencing
// null. No existing test pins this branch — a regression that dropped the null
// guard would crash with a confusing "cannot read properties of null" instead
// of the intended diagnostic.
//
// Deterministic: real store I/O against a tmp workspace, no clock/network. The
// "disappearance" is simulated by spying on the SAME run-module instance that
// round-controller imports loadDeliberation from, so the spy intercepts the
// production call.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as rc from "@zana-ai/work/src/deliberation/round-controller.ts";
import type { Deliberation, Vote } from "@zana-ai/work/src/deliberation/types.ts";

function makeVote(
  d: Deliberation,
  voterId: string,
  bit: "APPROVE" | "CHANGES",
  round: number,
): Vote {
  return {
    voterId,
    profileId: voterId + "-profile",
    modelId: "claude-opus",
    round,
    bit,
    rationaleHash: "sha256:" + voterId.padEnd(8, "0").repeat(8).slice(0, 64),
    promptSnapshotHash: d.promptSnapshotHash,
    ts: new Date().toISOString(),
  };
}

/** Push a deliberation into CONVERGING round 1 with 3 unanimous APPROVE votes. */
function setupUnanimous(): Deliberation {
  const proposed = run.propose({
    question: "q",
    voters: [{ profileId: "voter-1" }, { profileId: "voter-2" }, { profileId: "voter-3" }],
    promptSnapshot: "prompt",
    rounds: 2,
    quorum: 3,
  });
  run.transition(proposed.id, "REVIEWING");
  run.transition(proposed.id, "SYNTHESIZING", {
    synthesisHash: "sha256:" + "a".repeat(64),
  });
  const d = run.transition(proposed.id, "CONVERGING", { currentRound: 1 });
  for (const v of ["v1", "v2", "v3"]) {
    run.recordVote(proposed.id, makeVote(d, v, "APPROVE", 1));
  }
  return run.loadDeliberation(proposed.id)!;
}

describe("applyDecision — deliberation disappears mid-retry", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-rc-gone-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try {
      (core as any).project.workspaceContext.init(tmpRoot);
    } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("throws a 'disappeared during retry' error when reload returns null after a stale write", async () => {
    const d = setupUnanimous();
    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("SETTLE");

    // After the first (stale) write throws StaleDeliberationError, the retry
    // reload finds the deliberation gone.
    const loadSpy = vi
      .spyOn(run, "loadDeliberation")
      .mockReturnValue(null as any);

    let threw: unknown;
    try {
      await rc.applyDecision(d.id, decision, {
        expectedVersion: d.version - 1, // stale → forces the StaleDeliberationError path
        maxRetries: 3,
      });
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/disappeared during retry/);
    expect((threw as Error).message).toContain(d.id);
    // The reload was the thing that observed the disappearance.
    expect(loadSpy).toHaveBeenCalledWith(d.id);
  });
});
