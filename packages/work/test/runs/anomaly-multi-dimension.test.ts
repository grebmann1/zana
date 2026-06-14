import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// The base anomaly.test.ts only ever trips ONE near-limit dimension at a time
// (plus, in the multi-anomaly case, a non-zero exit). It never exercises a run
// that blows cost AND duration AND tokens simultaneously. That case guards an
// important invariant: all three near-limit checks share `kind: "near-limit"`,
// so each must be emitted independently — a regression that deduped anomalies
// by `kind` would silently drop two of the three dimensions while still
// reporting a single near-limit. This locks the per-dimension independence,
// declaration order (cost → duration → tokens), and overall severity.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — all near-limit dimensions trip at once", () => {
  it("emits one independent near-limit anomaly per dimension, in source order", () => {
    // cost over cap (critical), duration in warn band, tokens over cap (critical).
    const result = detectAnomalies(
      {
        exitCode: 0,
        costUsd: 6, // >= maxCostUsd → critical
        durationMs: 9 * 60 * 1000, // 540s, >= 80% of 600s, < cap → warn
        tokensIn: 700_000,
        tokensOut: 400_000, // sum 1.1M >= maxTokens → critical
      },
      LIMITS,
    );

    // Three distinct near-limit anomalies — not collapsed by shared kind.
    expect(result.anomalies).toHaveLength(3);
    expect(result.anomalies.every((a) => a.kind === "near-limit")).toBe(true);

    // Order follows the checks in the implementation: cost, then duration, then tokens.
    expect(result.anomalies[0].detail).toContain("cost $6.00");
    expect(result.anomalies[1].detail).toContain("duration 540s");
    expect(result.anomalies[2].detail).toContain("1100000 tokens");

    // Per-dimension severity is preserved; overall is the max (critical).
    expect(result.anomalies.map((a) => a.severity)).toEqual([
      "critical",
      "warn",
      "critical",
    ]);
    expect(result.severity).toBe("critical");
  });
});
