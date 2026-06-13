// Focused test for an untested degenerate input to applyDegradation():
// an empty council — zero successful voters AND zero dropped voters.
//
// The `all_probes_failed` branch is guarded by `droppedVoters.length > 0`
// (quorum.ts line 227), so with no drops it must NOT fire — even though
// there are zero survivors. Execution falls through to the quorum check,
// where 0 < quorum yields `quorum_lost`. Every existing all_probes_failed
// test passes ≥1 drop, and every quorum_lost test passes ≥1 survivor, so
// this precedence guard is otherwise unexercised.
//
// Pure function, no I/O, no real Claude — fully deterministic.
import { describe, it, expect } from "vitest";
import { applyDegradation } from "@zana-ai/work/src/deliberation/quorum.ts";

describe("applyDegradation — empty council (no survivors, no drops)", () => {
  it("falls through to quorum_lost, NOT all_probes_failed, when there are zero drops", () => {
    const result = applyDegradation([], [], {
      candidateCount: 0,
      quorum: 1,
    });
    expect(result.decision).toBe("ESCALATED");
    // The all_probes_failed guard (droppedVoters.length > 0) is not satisfied,
    // so the reason must be quorum_lost.
    expect(result.reason).toBe("quorum_lost");
    expect(result.rationale).toContain("only 0 of 0 candidates");
    expect(result.rationale).toContain("quorum=1");
  });

  it("does not escalate on dropout_was_dissenter when the dropped set is empty", () => {
    // previousDissenterProfileIds is non-empty, but there are no drops to match
    // against — the dropout-bias rule must not fire on an empty council.
    const result = applyDegradation([], [], {
      candidateCount: 0,
      quorum: 2,
      previousDissenterProfileIds: ["c"],
    });
    expect(result.decision).toBe("ESCALATED");
    expect(result.reason).toBe("quorum_lost");
  });
});
