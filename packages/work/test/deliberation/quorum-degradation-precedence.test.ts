// Check-ORDER precedence for applyDegradation in quorum.ts.
//
// quorum.ts documents (lines ~195-201) that the order of checks matters:
//   1. dropout_was_dissenter   (anti-dropout-bias — FIRST, even if quorum holds)
//   2. all_probes_failed       (no survivors AND >=1 drop)
//   3. quorum_lost             (too few survivors)
//   4. READY
//
// Existing suites pin check-1-over-check-3 (quorum.test.ts "even if quorum
// holds") and the check-2 / check-3 guard boundaries. What none of them pin is
// check-1-over-check-2: a TOTAL wipeout (zero survivors, every candidate
// dropped) where one of the dropped candidates was a previous dissenter must
// still report `dropout_was_dissenter`, NOT `all_probes_failed`. The anti-
// dropout-bias signal is the more actionable one and must win even when the
// council collapsed entirely. A future reorder that moved the all_probes_failed
// check above the dissenter check would silently swallow the bias signal — this
// test guards that.
//
// applyDegradation is pure: no I/O, no clock, no shared state.
import { describe, it, expect } from "vitest";
import { applyDegradation } from "@zana-ai/work/src/deliberation/quorum.ts";

describe("applyDegradation — check precedence on total wipeout", () => {
  it("reports dropout_was_dissenter (not all_probes_failed) when every voter dropped and one was a prior dissenter", () => {
    // Zero survivors + all dropped → the all_probes_failed guard is satisfied,
    // but a dropped candidate ("c") was a previous-round dissenter, so the
    // anti-dropout-bias check must fire first.
    const dropped = [
      { profileId: "c", reason: "timeout" as const, detail: "probe timed out" },
      { profileId: "d", reason: "spawn" as const, detail: "spawn failed" },
    ];

    const decision = applyDegradation([], dropped, {
      candidateCount: 2,
      quorum: 2,
      previousDissenterProfileIds: ["c"],
    });

    expect(decision.decision).toBe("ESCALATED");
    expect(decision.reason).toBe("dropout_was_dissenter");
    // Rationale names the offending dissenter profile, not a probe-count message.
    expect(decision.rationale).toMatch(/profile=c/);
  });

  it("falls back to all_probes_failed on a total wipeout when NO dropped voter was a prior dissenter", () => {
    // Same total-wipeout shape, but the prior dissenter ("z") is not among the
    // dropped set, so check 1 does not fire and check 2 (all_probes_failed) wins
    // ahead of check 3 (quorum_lost).
    const dropped = [
      { profileId: "c", reason: "timeout" as const, detail: "probe timed out" },
      { profileId: "d", reason: "spawn" as const, detail: "spawn failed" },
    ];

    const decision = applyDegradation([], dropped, {
      candidateCount: 2,
      quorum: 2,
      previousDissenterProfileIds: ["z"],
    });

    expect(decision.decision).toBe("ESCALATED");
    expect(decision.reason).toBe("all_probes_failed");
  });
});
