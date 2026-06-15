// Focused test for decide() — tallyForRound's handling of an unrecognized vote
// bit, a defensive branch not covered by the existing round-controller tests.
//
// tallyForRound (round-controller.ts) tallies with:
//     if (v.bit === "APPROVE") tally.approve++;
//     else if (v.bit === "CHANGES") tally.changes++;
//
// The `else if` (not a bare `else`) means a vote whose bit is NEITHER value —
// a malformed record, a legacy "ABSTAIN", an out-of-enum value — is counted
// toward neither tally. Consequently such a vote:
//   1. does NOT contribute to the round's quorum (votesInRound = approve+changes), and
//   2. does NOT count as a CHANGES vote, so it cannot block convergence.
//
// This pins both facts so a refactor that collapsed the `else if` into a bare
// `else` (which would silently reclassify every unknown bit as CHANGES and
// block convergence) is caught. decide() is pure — no I/O, no clock.

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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as Deliberation;
}

function vote(bit: string, round: number, voterId: string) {
  return {
    voterId,
    profileId: voterId + "-profile",
    modelId: "m",
    round,
    bit: bit as any, // intentionally allow an off-enum bit for the defensive branch
    rationaleHash: "sha256:" + "a".repeat(64),
    promptSnapshotHash: "sha256:" + "a".repeat(64),
    ts: "2026-01-01T00:00:00.000Z",
  };
}

describe("decide() — unrecognized vote bit is counted toward neither tally", () => {
  it("does not count an unknown bit toward quorum (so the round can fall short)", () => {
    // quorum=2; one real APPROVE plus one unknown-bit vote. The unknown bit
    // must NOT count toward quorum, leaving only 1 effective vote → quorum_lost.
    const d = minDel({
      currentRound: 1,
      rounds: 2,
      quorum: 2,
      votes: [vote("APPROVE", 1, "v1"), vote("ABSTAIN", 1, "v2")],
    });

    const decision = decide({ deliberation: d });

    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("quorum_lost");
    expect(decision.tally).toEqual({ approve: 1, changes: 0 });
  });

  it("does not treat an unknown bit as CHANGES, so it cannot block convergence", () => {
    // quorum=1; one real APPROVE meets quorum, and an unknown-bit vote is
    // present. Since the unknown bit is NOT counted as CHANGES, changes===0 and
    // the round converges to SETTLE/approve rather than advancing/escalating.
    const d = minDel({
      currentRound: 1,
      rounds: 2,
      quorum: 1,
      votes: [vote("APPROVE", 1, "v1"), vote("ABSTAIN", 1, "v2")],
    });

    const decision = decide({ deliberation: d });

    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve");
    expect(decision.tally).toEqual({ approve: 1, changes: 0 });
  });
});
