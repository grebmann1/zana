import { describe, it, expect } from "vitest";

import * as rc from "@zana-ai/work/src/deliberation/round-controller.ts";
import type { Deliberation, VoteBit } from "@zana-ai/work/src/deliberation/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// decide() — escalation-reason precedence.
//
// decide() is a pure function over a deliberation record (no I/O, no clock), so
// we construct a minimal record inline rather than persisting through run.ts.
//
// The risk gate (riskTag === "high") sits ABOVE the quorum check in decide().
// Existing coverage proves risk_high beats a clean SETTLE, but NOT that it beats
// quorum_lost. That ordering matters for the audit trail: a high-risk
// deliberation that also failed quorum MUST escalate as "risk_high" (a policy
// decision a human owns), never "quorum_lost" — otherwise the reason
// misattributes a deliberate risk gate to an incidental vote shortfall.
// ─────────────────────────────────────────────────────────────────────────────

function deliberation(opts: {
  riskTag?: "low" | "medium" | "high";
  quorum: number;
  rounds: number;
  currentRound: number;
  votes: Array<{ bit: VoteBit }>;
}): Deliberation {
  return {
    id: "d-test",
    state: "CONVERGING",
    question: "q",
    voters: [],
    rounds: opts.rounds,
    quorum: opts.quorum,
    mode: "synthesis",
    riskTag: opts.riskTag,
    promptSnapshotHash: "sha256:" + "a".repeat(64),
    currentRound: opts.currentRound,
    votes: opts.votes.map((v, i) => ({
      voterId: `v${i + 1}`,
      profileId: `v${i + 1}-profile`,
      modelId: "claude-opus",
      round: opts.currentRound,
      bit: v.bit,
      rationaleHash: "sha256:" + "b".repeat(64),
      promptSnapshotHash: "sha256:" + "a".repeat(64),
      ts: "2026-01-01T00:00:00.000Z",
    })),
    dissent: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
  };
}

describe("decide() — risk gate precedence over quorum", () => {
  it("escalates high-risk as 'risk_high' even when quorum is NOT met", () => {
    // quorum=3 but only 1 vote landed → quorum_lost would normally fire.
    // riskTag=high must win: reason is risk_high, not quorum_lost.
    const d = deliberation({
      riskTag: "high",
      quorum: 3,
      rounds: 2,
      currentRound: 1,
      votes: [{ bit: "APPROVE" }],
    });

    const decision = rc.decide({ deliberation: d });

    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("risk_high");
    // The tally still reflects what actually landed this round.
    expect(decision.tally).toEqual({ approve: 1, changes: 0 });
  });

  it("falls through to 'quorum_lost' for the same shortfall when risk is not high", () => {
    // Identical vote shortfall, riskTag=low → the quorum check now governs.
    // Confirms the precedence above is the risk gate, not a quorum side effect.
    const d = deliberation({
      riskTag: "low",
      quorum: 3,
      rounds: 2,
      currentRound: 1,
      votes: [{ bit: "APPROVE" }],
    });

    const decision = rc.decide({ deliberation: d });

    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("quorum_lost");
  });
});
