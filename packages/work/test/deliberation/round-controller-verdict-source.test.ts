// Focused test for the `verdictSource` audit field stamped by applyDecision.
//
// Invariant (types.ts):
//   "council" — voters reached consensus on their own (decide() → SETTLE).
//
// applyDecision must:
//   • stamp verdictSource="council" on SETTLE (line 137 of round-controller.ts)
//   • leave verdictSource undefined on ESCALATE (set later by override)
//   • leave verdictSource undefined on ADVANCE_ROUND (not yet settled)
//
// These distinctions matter for audit consumers that ask whether a verdict
// came from the council, an auto-judge, or a human operator override.

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (mirror the pattern from round-controller.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

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

/** Push a deliberation into CONVERGING / round 1, quorum = 3, rounds = 2. */
function setupConverging(): Deliberation {
  const voters = [
    { profileId: "voter-1" },
    { profileId: "voter-2" },
    { profileId: "voter-3" },
  ];
  const proposed = run.propose({
    question: "q",
    voters,
    promptSnapshot: "prompt",
    rounds: 2,
    quorum: 3,
  });
  run.transition(proposed.id, "REVIEWING");
  run.transition(proposed.id, "SYNTHESIZING", {
    synthesisHash: "sha256:" + "a".repeat(64),
  });
  run.transition(proposed.id, "CONVERGING", { currentRound: 1 });
  return run.loadDeliberation(proposed.id)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("applyDecision — verdictSource audit field", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-vs-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try {
      (core as any).project.workspaceContext.init(tmpRoot);
    } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("SETTLE: verdictSource is 'council' — council reached consensus without a human override", async () => {
    const d = setupConverging();
    // All three voters APPROVE in round 1 → unanimous → SETTLE
    run.recordVote(d.id, makeVote(d, "v1", "APPROVE", 1));
    run.recordVote(d.id, makeVote(d, "v2", "APPROVE", 1));
    run.recordVote(d.id, makeVote(d, "v3", "APPROVE", 1));
    const dFinal = run.loadDeliberation(d.id)!;

    const decision = rc.decide({ deliberation: dFinal });
    expect(decision.action).toBe("SETTLE");

    const result = await rc.applyDecision(dFinal.id, decision);

    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdictSource).toBe("council");
  });

  it("ESCALATE (quorum_lost): verdictSource is undefined — override not yet applied", async () => {
    const d = setupConverging();
    // Only 1 vote when quorum = 3 → quorum_lost → ESCALATE
    run.recordVote(d.id, makeVote(d, "v1", "APPROVE", 1));
    const dFinal = run.loadDeliberation(d.id)!;

    const decision = rc.decide({ deliberation: dFinal });
    expect(decision.action).toBe("ESCALATE");
    expect((decision as any).reason).toBe("quorum_lost");

    const result = await rc.applyDecision(dFinal.id, decision);

    expect(result.deliberation.state).toBe("ESCALATED");
    expect(result.deliberation.verdictSource).toBeUndefined();
  });

  it("ADVANCE_ROUND: verdictSource is undefined — deliberation not yet settled", async () => {
    const d = setupConverging();
    // 2 APPROVE + 1 CHANGES with rounds = 2 → split, cap not reached → ADVANCE_ROUND
    run.recordVote(d.id, makeVote(d, "v1", "APPROVE", 1));
    run.recordVote(d.id, makeVote(d, "v2", "APPROVE", 1));
    run.recordVote(d.id, makeVote(d, "v3", "CHANGES", 1));
    const dFinal = run.loadDeliberation(d.id)!;

    const decision = rc.decide({ deliberation: dFinal });
    expect(decision.action).toBe("ADVANCE_ROUND");

    const result = await rc.applyDecision(dFinal.id, decision);

    expect(result.deliberation.state).toBe("CONVERGING");
    expect(result.deliberation.currentRound).toBe(2);
    expect(result.deliberation.verdictSource).toBeUndefined();
  });
});
