// Focused test for the non-stale error rethrow branch of applyDecision
// (round-controller.ts line 188):
//
//   } catch (err) {
//     if (!(err instanceof StaleDeliberationError)) {
//       throw err;            // ← THIS branch
//     }
//     ...retry on OCC conflict...
//   }
//
// Every other applyDecision retry test drives the StaleDeliberationError path
// (OCC version mismatch). NONE exercises what happens when applyOnce throws a
// DIFFERENT error. The contract is: only optimistic-concurrency conflicts are
// retried. Any other failure (e.g. an illegal state transition) MUST surface
// immediately — unwrapped and un-retried. A regression that broadened the catch
// to "retry on any error" would silently burn the retry budget and bury the
// real failure under a generic "exceeded N retries" message.
//
// Setup is deterministic and faithful (real run.ts state machine, real
// checkpoint store rooted at a tmpdir) — no clock or randomness in the
// assertions. SETTLED is a terminal state (TRANSITIONS.SETTLED === []), so any
// transition out of it throws a plain Error("illegal transition ..."), which is
// not a StaleDeliberationError.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as rc from "@zana-ai/work/src/deliberation/round-controller.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

// Drive a fresh deliberation through to CONVERGING (round 1) with `voterCount`
// unanimous APPROVE votes, so decide() would yield a clean SETTLE.
function setupConverged(voterCount = 3): Deliberation {
  const voters = Array.from({ length: voterCount }, (_, i) => ({
    profileId: `voter-${i + 1}`,
  }));
  const proposed = run.propose({
    question: "q",
    voters,
    promptSnapshot: "prompt",
    rounds: 2,
    quorum: voterCount,
  });
  run.transition(proposed.id, "REVIEWING");
  run.transition(proposed.id, "SYNTHESIZING", {
    synthesisHash: "sha256:" + "a".repeat(64),
  });
  const d = run.transition(proposed.id, "CONVERGING", { currentRound: 1 });
  for (let i = 0; i < voterCount; i++) {
    run.recordVote(proposed.id, {
      voterId: `v${i + 1}`,
      profileId: `v${i + 1}-profile`,
      modelId: "claude-opus",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "b".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    });
  }
  return run.loadDeliberation(proposed.id)!;
}

describe("applyDecision — non-stale error is rethrown immediately (not retried)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-rc-rethrow-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("propagates an illegal-transition Error verbatim and does NOT wrap it as 'exceeded N retries'", async () => {
    const d = setupConverged(3);

    // First SETTLE succeeds → deliberation reaches the terminal SETTLED state.
    const settled = await rc.applyDecision(
      d.id,
      { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } },
    );
    expect(settled.deliberation.state).toBe("SETTLED");

    // A SETTLED deliberation can transition nowhere (TRANSITIONS.SETTLED === []).
    // Applying ANOTHER decision makes applyOnce -> transition throw a plain
    // Error("illegal transition SETTLED -> ..."), which is NOT a
    // StaleDeliberationError. expectedVersion matches current, so the OCC guard
    // passes and we hit the illegal-transition check, not the stale path.
    const fresh = run.loadDeliberation(d.id)!;

    let threw: unknown;
    try {
      await rc.applyDecision(
        d.id,
        { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } },
        // maxRetries deliberately generous: if the non-stale error were
        // (wrongly) retried, the failure would surface as "exceeded 5 retries"
        // instead of the raw illegal-transition message asserted below.
        { expectedVersion: fresh.version, maxRetries: 5 },
      );
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/illegal transition/);
    // Proves the catch took the immediate-rethrow path: no retry, no wrapper.
    expect((threw as Error).message).not.toMatch(/exceeded .* retries/);
  });
});
