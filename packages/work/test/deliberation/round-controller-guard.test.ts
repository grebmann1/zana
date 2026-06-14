// Focused tests for decide() edge-cases not covered by round-controller.test.ts:
//   1. Input-validation guard — null / undefined / missing deliberation property
//   2. tallyForRound isolation — votes from prior rounds must NOT influence
//      the decision for the current round
//
// These tests are pure (no file I/O, no workspace context) because decide() is
// a synchronous, side-effect-free function that only reads deliberation fields.

import { describe, it, expect } from "vitest";
import { decide } from "@zana-ai/work/src/deliberation/round-controller.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

// ── minimal deliberation factory ─────────────────────────────────────────────
// Builds the smallest Deliberation object that decide() needs to read.
// Tests can override individual fields via `overrides`.

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    ts: new Date().toISOString(),
  };
}

function changesVote(round: number, voterId = "v1") {
  return { ...approveVote(round, voterId), bit: "CHANGES" as const };
}

// ── input-validation guard ────────────────────────────────────────────────────

describe("decide() — input-validation guard", () => {
  it("throws when called with null", () => {
    expect(() => decide(null as any)).toThrow("decide: deliberation is required");
  });

  it("throws when called with undefined", () => {
    expect(() => decide(undefined as any)).toThrow("decide: deliberation is required");
  });

  it("throws when called with an empty object (no deliberation property)", () => {
    expect(() => decide({} as any)).toThrow("decide: deliberation is required");
  });

  it("throws when input.deliberation is null", () => {
    expect(() => decide({ deliberation: null } as any)).toThrow(
      "decide: deliberation is required",
    );
  });

  it("throws when input.deliberation is undefined", () => {
    expect(() => decide({ deliberation: undefined } as any)).toThrow(
      "decide: deliberation is required",
    );
  });
});

// ── tallyForRound isolation ───────────────────────────────────────────────────

describe("decide() — tallyForRound only counts votes from currentRound", () => {
  it("ignores CHANGES votes from a prior round when current round is unanimous APPROVE", () => {
    // Round 1: both voters voted CHANGES (prior round, should be ignored)
    // Round 2: both voters voted APPROVE (current round, quorum = 2)
    const d = minDel({
      currentRound: 2,
      rounds: 3,
      quorum: 2,
      votes: [
        changesVote(1, "v1"),
        changesVote(1, "v2"),
        approveVote(2, "v1"),
        approveVote(2, "v2"),
      ],
    });

    const decision = decide({ deliberation: d });
    // Current round is unanimous APPROVE → should SETTLE, not ESCALATE
    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve");
    expect(decision.tally).toEqual({ approve: 2, changes: 0 });
  });

  it("ignores APPROVE votes from a future round when computing the current round tally", () => {
    // Round 1: only 1 APPROVE so far (below quorum=2); round 2 has a stray
    // APPROVE that must NOT count toward the current round.
    const d = minDel({
      currentRound: 1,
      rounds: 3,
      quorum: 2,
      votes: [
        approveVote(1, "v1"),  // current round — counts
        approveVote(2, "v2"),  // future round  — must NOT count
      ],
    });

    const decision = decide({ deliberation: d });
    // Only 1 vote in round 1, quorum = 2 → quorum_lost
    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("quorum_lost");
    expect(decision.tally).toEqual({ approve: 1, changes: 0 });
  });

  it("tally counts both APPROVE and CHANGES in the current round correctly", () => {
    // Round 1 has 1 APPROVE, 1 CHANGES from a prior run (ignored).
    // Round 2 (current) has 3 APPROVE and 1 CHANGES.
    const d = minDel({
      currentRound: 2,
      rounds: 3,
      quorum: 4,
      votes: [
        approveVote(1, "v1"),   // prior — ignored
        changesVote(1, "v2"),   // prior — ignored
        approveVote(2, "v1"),
        approveVote(2, "v2"),
        approveVote(2, "v3"),
        changesVote(2, "v4"),
      ],
    });

    const decision = decide({ deliberation: d });
    // round 2: 3 APPROVE + 1 CHANGES = 4 votes (meets quorum=4); not capped (round 2 < rounds 3)
    // Has a CHANGES vote → not unanimous → ADVANCE_ROUND
    expect(decision.action).toBe("ADVANCE_ROUND");
    if (decision.action !== "ADVANCE_ROUND") throw new Error("type guard");
    // ADVANCE_ROUND carries only nextRound (no tally field)
    expect(decision.nextRound).toBe(3);
  });
});
