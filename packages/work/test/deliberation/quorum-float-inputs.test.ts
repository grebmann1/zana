// Focused tests for resolveQuorum's Math.floor() behaviour on float inputs.
//
// Every existing call-site passes integer n and integer (or keyword) spec, so
// the floor branches on both params are uncovered.  The implementation does:
//
//   const candidateCount = Math.max(0, Math.floor(n));   // float n → int
//   ...
//   const q = Math.floor(spec);                          // float spec → int
//
// These tests document the contract so a future refactor can't silently change
// truncation to rounding (or drop it entirely) without a test failure.

import { describe, it, expect } from "vitest";
import { resolveQuorum } from "@zana-ai/work/src/deliberation/quorum.ts";

describe("resolveQuorum — float candidate count (n) is floored before majority/all math", () => {
  it("majority of 3.7 candidates = majority of 3 = 2", () => {
    // Math.floor(3.7) → 3; majority(3) = floor(3/2)+1 = 2
    expect(resolveQuorum("majority", 3.7)).toBe(2);
  });

  it("majority of 1.9 candidates = majority of 1 = 1", () => {
    // Math.floor(1.9) → 1; majority(1) = floor(1/2)+1 = 1
    expect(resolveQuorum("majority", 1.9)).toBe(1);
  });

  it('"all" of 4.6 candidates = 4 (floor applied before Math.max)', () => {
    // Math.floor(4.6) → 4; all(4) = Math.max(1, 4) = 4
    expect(resolveQuorum("all", 4.6)).toBe(4);
  });

  it("numeric spec=2, float n=5.9 → treats n as 5 → result=2 (within [1, 5])", () => {
    // Math.floor(5.9) → 5; Math.min(5, Math.max(1, 2)) = 2
    expect(resolveQuorum(2, 5.9)).toBe(2);
  });
});

describe("resolveQuorum — float numeric spec is floored before clamping", () => {
  it("spec=2.7, n=5 → floor(2.7)=2, clamped to [1,5] → 2", () => {
    expect(resolveQuorum(2.7, 5)).toBe(2);
  });

  it("spec=0.9, n=3 → floor(0.9)=0, Math.max(1,0)=1, Math.min(3,1) → 1", () => {
    // Fractional spec below 1 is treated the same as spec=0 → clamp up to 1.
    expect(resolveQuorum(0.9, 3)).toBe(1);
  });

  it("spec=10.5, n=3 → floor(10.5)=10, Math.min(3,10) → 3 (capped at candidateCount)", () => {
    expect(resolveQuorum(10.5, 3)).toBe(3);
  });
});
