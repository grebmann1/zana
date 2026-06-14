// Focused boundary test for resolveQuorum's negative candidate-count guard.
//
// resolveQuorum floors AND clamps the candidate count via
// `Math.max(0, Math.floor(n))` before any majority/all/integer math. The
// existing suites pin positive floats (quorum-float-inputs) and exactly-zero
// (quorum-pure-fns), but never a NEGATIVE n. A regression dropping the
// `Math.max(0, …)` clamp would silently produce nonsensical quora — e.g.
// `"majority"` of -3 would be `Math.floor(-3/2)+1 === -1` instead of the
// clamped-up 1. This test locks the negative-n branch for all three spec forms.

import { describe, it, expect } from "vitest";
import { resolveQuorum } from "@zana-ai/work/src/deliberation/quorum.ts";

describe("resolveQuorum — negative candidate count is clamped to zero candidates", () => {
  it("'majority' of a negative n clamps up to 1 (never negative)", () => {
    // max(0, floor(-3)) === 0 → the candidateCount===0 branch returns 1.
    // Without the clamp this would be floor(-3/2)+1 === -1.
    expect(resolveQuorum("majority", -3)).toBe(1);
  });

  it("'all' of a negative n is 1, matching the zero-candidate floor", () => {
    expect(resolveQuorum("all", -5)).toBe(1);
  });

  it("a numeric spec with negative n falls into the zero-candidate path and returns the requested quorum", () => {
    // candidateCount===0 → Math.max(1, floor(4)) === 4 (not clamped down to n).
    expect(resolveQuorum(4, -2)).toBe(4);
  });

  it("a negative fractional n floors below zero then clamps to zero candidates", () => {
    // floor(-0.5) === -1 → max(0, -1) === 0 → majority-of-zero returns 1.
    expect(resolveQuorum("majority", -0.5)).toBe(1);
  });
});
