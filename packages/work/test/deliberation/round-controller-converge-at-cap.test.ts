// Focused tests for decide() precedence at the round cap.
//
// In decide(), the convergence check (every vote APPROVE → SETTLE) runs BEFORE
// the cap check (round >= rounds → ESCALATE cap_exhausted). So reaching the
// round cap does NOT force escalation on its own: a unanimous-APPROVE round
// settles even at the cap. cap_exhausted is reserved for a cap round that still
// has an outstanding CHANGES vote ("never auto-pick a verdict at the cap" only
// applies when the council is still split).
//
// The existing cap test (round-controller.test.ts) covers only the split-vote
// case (2 APPROVE / 1 CHANGES at cap → cap_exhausted). These tests lock the
// complementary branch: unanimous APPROVE AT the cap → SETTLE. Pure, no I/O.

import { describe, it, expect } from "vitest";
import { decide } from "@zana-ai/work/src/deliberation/round-controller.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

function minDel(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "test-del",
    state: "CONVERGING",
    question: "q",
    voters: [],
    rounds: 2,
    quorum: 2,
    mode: "tally",
    promptSnapshotHash: "sha256:" + "a".repeat(64),
    currentRound: 1,
    votes: [],
    dissent: [],
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as Deliberation;
}

function approveVote(round: number, voterId = "v1") {
  return {
    voterId,
    profileId: "p",
    modelId: "m",
    round,
    bit: "APPROVE" as const,
    rationaleHash: "sha256:" + "a".repeat(64),
    promptSnapshotHash: "sha256:" + "a".repeat(64),
    ts: "2026-06-13T00:00:00.000Z",
  };
}

describe("decide() — convergence wins over the cap check", () => {
  it("unanimous APPROVE at the cap round (currentRound === rounds) → SETTLE approve, NOT cap_exhausted", () => {
    const d = minDel({
      currentRound: 2,
      rounds: 2, // at the cap
      quorum: 2,
      votes: [approveVote(2, "v1"), approveVote(2, "v2")],
    });

    const decision = decide({ deliberation: d });

    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve");
    expect(decision.tally).toEqual({ approve: 2, changes: 0 });
  });

  it("unanimous APPROVE at the cap with prior dissent → SETTLE approve_with_conditions", () => {
    const d = minDel({
      currentRound: 2,
      rounds: 2, // at the cap
      quorum: 2,
      dissent: [{ note: "earlier concern" } as any],
      votes: [approveVote(2, "v1"), approveVote(2, "v2")],
    });

    const decision = decide({ deliberation: d });

    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve_with_conditions");
  });
});
