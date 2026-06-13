// Focused tests for the rationale strings produced by applyDegradation().
//
// quorum.test.ts already tests the `dropout_was_dissenter` rationale (line 273).
// The three remaining READY / ESCALATED rationale variants are uncovered:
//
//  1. READY — all candidates passed:
//       "all N candidates probed OK"
//  2. READY — some dropped but quorum met:
//       "X of N candidates probed OK (D dropped); quorum=Q met"
//  3. ESCALATED — all_probes_failed:
//       "all N candidate probes failed"
//  4. ESCALATED — quorum_lost:
//       "only X of N candidates passed probe; quorum=Q"
//
// The rationale becomes the `details` field of AssembleOutcome on ESCALATED
// paths and is the primary human-readable explanation shown in the MCP surface.
//
// All tests call the exported pure function directly — no I/O, no real Claude.

import { describe, it, expect } from "vitest";
import { applyDegradation } from "@zana-ai/work/src/deliberation/quorum.ts";
import type { Voter } from "@zana-ai/work/src/deliberation/types.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function voter(id: string): Voter {
  return { agentId: `ag-${id}`, profileId: id, modelId: "claude-test" };
}

const dropped1 = [{ profileId: "x", reason: "timeout" as const, detail: "timed out" }];
const dropped2 = [
  { profileId: "x", reason: "timeout" as const, detail: "timed out" },
  { profileId: "y", reason: "auth" as const, detail: "401" },
];

// ── READY — all candidates passed (no drops) ─────────────────────────────────

describe("applyDegradation — READY rationale when all candidates pass", () => {
  it("rationale says 'all N candidates probed OK' for N=1", () => {
    const result = applyDegradation([voter("a")], [], {
      candidateCount: 1,
      quorum: 1,
    });
    expect(result.decision).toBe("READY");
    expect(result.rationale).toBe("all 1 candidates probed OK");
  });

  it("rationale says 'all N candidates probed OK' for N=3", () => {
    const result = applyDegradation(
      [voter("a"), voter("b"), voter("c")],
      [],
      { candidateCount: 3, quorum: 2 },
    );
    expect(result.decision).toBe("READY");
    expect(result.rationale).toBe("all 3 candidates probed OK");
  });
});

// ── READY — some dropped but quorum met ──────────────────────────────────────

describe("applyDegradation — READY rationale when some candidates drop (quorum still met)", () => {
  it("rationale includes survivor count, total count, drop count, and quorum", () => {
    // 3 candidates, 1 dropped, quorum=2 → 2 survivors ≥ quorum → READY
    const result = applyDegradation(
      [voter("a"), voter("b")],
      dropped1,
      { candidateCount: 3, quorum: 2 },
    );
    expect(result.decision).toBe("READY");
    expect(result.rationale).toContain("2 of 3 candidates probed OK");
    expect(result.rationale).toContain("1 dropped");
    expect(result.rationale).toContain("quorum=2 met");
  });

  it("rationale reflects multiple drops (2 dropped, 1 survivor, quorum=1)", () => {
    // 3 candidates, 2 dropped, quorum=1 → 1 survivor ≥ quorum → READY
    const result = applyDegradation(
      [voter("z")],
      dropped2,
      { candidateCount: 3, quorum: 1 },
    );
    expect(result.decision).toBe("READY");
    expect(result.rationale).toContain("1 of 3 candidates probed OK");
    expect(result.rationale).toContain("2 dropped");
    expect(result.rationale).toContain("quorum=1 met");
  });
});

// ── ESCALATED — all_probes_failed ────────────────────────────────────────────

describe("applyDegradation — all_probes_failed rationale", () => {
  it("rationale says 'all N candidate probes failed' for N=1", () => {
    const result = applyDegradation(
      [],
      [{ profileId: "a", reason: "timeout" as const, detail: "timed out" }],
      { candidateCount: 1, quorum: 1 },
    );
    expect(result.decision).toBe("ESCALATED");
    expect(result.reason).toBe("all_probes_failed");
    expect(result.rationale).toBe("all 1 candidate probes failed");
  });

  it("rationale says 'all N candidate probes failed' for N=2", () => {
    const result = applyDegradation([], dropped2, {
      candidateCount: 2,
      quorum: 1,
    });
    expect(result.decision).toBe("ESCALATED");
    expect(result.reason).toBe("all_probes_failed");
    expect(result.rationale).toBe("all 2 candidate probes failed");
  });
});

// ── ESCALATED — quorum_lost ───────────────────────────────────────────────────

describe("applyDegradation — quorum_lost rationale", () => {
  it("rationale includes survivor/total/quorum numbers", () => {
    // 3 candidates, 1 passed, quorum=2 → quorum_lost
    const result = applyDegradation([voter("a")], dropped2, {
      candidateCount: 3,
      quorum: 2,
    });
    expect(result.decision).toBe("ESCALATED");
    expect(result.reason).toBe("quorum_lost");
    expect(result.rationale).toContain("only 1 of 3 candidates");
    expect(result.rationale).toContain("passed probe");
    expect(result.rationale).toContain("quorum=2");
  });

  it("rationale reflects 0 survivors against a larger council", () => {
    // 5 candidates, 0 passed, quorum=3 → this would be all_probes_failed not quorum_lost,
    // because successfulVoters.length === 0 AND droppedVoters.length > 0 hits all_probes_failed first.
    // Test the *quorum_lost* branch: at least 1 survivor but below quorum.
    const result = applyDegradation(
      [voter("a"), voter("b")],
      [
        { profileId: "c", reason: "timeout" as const, detail: "." },
        { profileId: "d", reason: "timeout" as const, detail: "." },
        { profileId: "e", reason: "timeout" as const, detail: "." },
      ],
      { candidateCount: 5, quorum: 3 },
    );
    expect(result.decision).toBe("ESCALATED");
    expect(result.reason).toBe("quorum_lost");
    expect(result.rationale).toContain("only 2 of 5 candidates");
    expect(result.rationale).toContain("quorum=3");
  });
});
