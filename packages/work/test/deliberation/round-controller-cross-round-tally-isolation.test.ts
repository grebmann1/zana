// Per-round tally isolation invariant in round-controller.decide().
//
// tallyForRound filters votes with `if (v.round !== round) continue;` so only
// votes cast in the CURRENT round count toward quorum/convergence. Every other
// round-controller test records votes in the same round as `currentRound`, so
// dropping that filter would let prior-round votes leak into the tally with no
// failing test. This pins it: three APPROVE votes stranded in round 1 with zero
// votes in round 2 must yield ESCALATE/quorum_lost, never a spurious SETTLE.
// Real run.ts state machine over a tmpdir — deterministic, no network/Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("round controller — cross-round tally isolation", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-rc-xround-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("excludes prior-round APPROVE votes from the current round's tally → ESCALATE quorum_lost", () => {
    const proposed = run.propose({
      question: "q",
      voters: [{ profileId: "voter-1" }, { profileId: "voter-2" }, { profileId: "voter-3" }],
      promptSnapshot: "prompt",
      rounds: 2,
      quorum: 3,
    });

    // PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING (round 1)
    run.transition(proposed.id, "REVIEWING");
    run.transition(proposed.id, "SYNTHESIZING", {
      synthesisHash: "sha256:" + "a".repeat(64),
    });
    const r1 = run.transition(proposed.id, "CONVERGING", { currentRound: 1 });

    // Three APPROVE votes land in round 1 — enough to meet quorum *for round 1*.
    run.recordVote(proposed.id, makeVote(r1, "v1", "APPROVE", 1));
    run.recordVote(proposed.id, makeVote(r1, "v2", "APPROVE", 1));
    run.recordVote(proposed.id, makeVote(r1, "v3", "APPROVE", 1));

    // The deliberation advances to round 2, where NO new votes have landed yet.
    run.transition(proposed.id, "CONVERGING", { currentRound: 2 });
    const d = run.loadDeliberation(proposed.id)!;
    expect(d.currentRound).toBe(2);

    const decision = rc.decide({ deliberation: d });

    // The stale round-1 APPROVE votes must NOT satisfy round 2. The current
    // round's tally is empty, so quorum is unmet and we escalate.
    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("quorum_lost");
    // Tally reflects only round 2 — zero votes, not the three from round 1.
    expect(decision.tally).toEqual({ approve: 0, changes: 0 });
  });
});
