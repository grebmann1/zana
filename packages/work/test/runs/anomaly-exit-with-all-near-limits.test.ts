import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Cross-section ordering invariant: when a run trips a non-zero exit AND all
// three near-limit dimensions at once, detectAnomalies emits exactly four
// anomalies with `non-zero-exit` FIRST (it is pushed ahead of the near-limit
// block in the implementation), followed by cost → duration → tokens in
// source order. The base anomaly.test.ts "max severity" case only ever trips
// two anomalies and asserts a *sorted* kind list, so the real emission order
// across the exit/near-limit boundary is never locked. A refactor that moved
// the exit check below the near-limit block — or reordered the dimensions —
// would slip past every existing test. This pins it.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — non-zero exit plus all near-limit dimensions", () => {
  it("emits non-zero-exit first, then cost/duration/tokens in source order", () => {
    const result = detectAnomalies(
      {
        exitCode: 137, // non-zero → warn
        costUsd: 6, // >= maxCostUsd → critical
        durationMs: 9 * 60 * 1000, // 540s, >= 80% of 600s, < cap → warn
        tokensIn: 700_000,
        tokensOut: 400_000, // sum 1.1M >= maxTokens → critical
      },
      LIMITS,
    );

    // Exactly four anomalies — exit + three independent near-limit dimensions.
    expect(result.anomalies).toHaveLength(4);

    // Emission order: exit precedes the near-limit block; near-limits stay in
    // declaration order (cost → duration → tokens).
    expect(result.anomalies.map((a) => a.kind)).toEqual([
      "non-zero-exit",
      "near-limit",
      "near-limit",
      "near-limit",
    ]);
    expect(result.anomalies[0].detail).toContain("137");
    expect(result.anomalies[1].detail).toContain("cost $6.00");
    expect(result.anomalies[2].detail).toContain("duration 540s");
    expect(result.anomalies[3].detail).toContain("1100000 tokens");

    // Per-dimension severities preserved; overall is the max (critical).
    expect(result.anomalies.map((a) => a.severity)).toEqual([
      "warn",
      "critical",
      "warn",
      "critical",
    ]);
    expect(result.severity).toBe("critical");
  });
});
