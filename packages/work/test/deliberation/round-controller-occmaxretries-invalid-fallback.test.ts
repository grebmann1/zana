// applyDecision — invalid runtime-config occMaxRetries falls back to the
// defensive default (DEFAULT_MAX_RETRIES_FALLBACK = 3), NOT to 0.
//
// round-controller.ts resolves the OCC retry budget at entry:
//
//   const configuredMax = (() => {
//     const v = getRuntimeConfig().occMaxRetries;
//     return typeof v === "number" && v >= 0 ? Math.floor(v) : DEFAULT_MAX_RETRIES_FALLBACK;
//   })();
//
// The existing suite pins occMaxRetries=0 (→ "exceeded 0 retries") and the
// explicit-override path, but nothing exercises the guard's FALSE branch — a
// garbage config value (negative number, or a non-number). The contract that
// matters operationally: a corrupt config value must NOT silently disable
// retries (which a fallback of 0, or letting the raw value through, would do).
// It must fall back to a positive default so a single recoverable stale
// collision still resolves instead of hard-failing.
//
// Observable proof: with an invalid occMaxRetries and no explicit maxRetries,
// a stale-but-recoverable expectedVersion (one less than current) must still
// SETTLE — because the fallback budget is >= 1. Under a budget of 0 the same
// call throws "exceeded 0 retries". This distinguishes "fell back to default"
// from "treated invalid as 0".
//
// Real run.ts + workspace-context + checkpoint store; deterministic, no Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as rc from "@zana-ai/work/src/deliberation/round-controller.ts";
import * as runtimeConfig from "@zana-ai/work/src/deliberation/runtime-config.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

// Build a CONVERGING deliberation at round 1 of 2 with 3 unanimous APPROVE
// votes → decide() yields SETTLE approve. Mirrors round-controller.test.ts.
function setupUnanimous(): Deliberation {
  const proposed = run.propose({
    question: "q",
    voters: [{ profileId: "voter-1" }, { profileId: "voter-2" }, { profileId: "voter-3" }],
    promptSnapshot: "prompt",
    rounds: 2,
    quorum: 3,
  });
  run.transition(proposed.id, "REVIEWING");
  run.transition(proposed.id, "SYNTHESIZING", { synthesisHash: "sha256:" + "a".repeat(64) });
  const d = run.transition(proposed.id, "CONVERGING", { currentRound: 1 });

  for (const voterId of ["v1", "v2", "v3"]) {
    run.recordVote(proposed.id, {
      voterId,
      profileId: voterId + "-profile",
      modelId: "claude-opus",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + voterId.padEnd(8, "0").repeat(8).slice(0, 64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    });
  }
  return run.loadDeliberation(proposed.id)!;
}

describe("applyDecision — invalid occMaxRetries falls back to the positive default", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-rc-occ-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    runtimeConfig.resetRuntimeConfig();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("negative occMaxRetries → retry budget defaults (>=1), recoverable stale collision SETTLES", async () => {
    runtimeConfig.setRuntimeConfig({ occMaxRetries: -5 });
    const d = setupUnanimous();

    // Stale by one version; the reload+recompute on the first retry resolves it.
    // Omit maxRetries so the resolution path reads the (invalid) config value.
    const result = await rc.applyDecision(
      d.id,
      { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } },
      { expectedVersion: d.version - 1 },
    );

    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdict).toBe("approve");
  });

  it("non-number occMaxRetries → retry budget defaults (>=1), recoverable stale collision SETTLES", async () => {
    // typeof v === "number" guard's FALSE branch.
    runtimeConfig.setRuntimeConfig({ occMaxRetries: "3" as unknown as number });
    const d = setupUnanimous();

    const result = await rc.applyDecision(
      d.id,
      { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } },
      { expectedVersion: d.version - 1 },
    );

    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdict).toBe("approve");
  });
});
