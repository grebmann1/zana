import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the human-readable `detail` strings on the cost and
// token near-limit branches of detectAnomalies. The base anomaly.test.ts
// asserts the *severity* of these branches but never their detail text, and
// anomaly-duration-near-limit.test.ts only pins the duration string. So the
// cost `.toFixed(2)` formatting and the raw-token interpolation are untested.
// Pure function — fully deterministic, no clock/IO.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — near-limit detail strings", () => {
  it("formats the cost detail with 2 decimals and the rounded threshold percent", () => {
    // 0.8 * 5 = 4.0 → in the warn band; 4 must render as "4.00" via toFixed(2).
    const result = detectAnomalies({ exitCode: 0, costUsd: 4 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].detail).toBe(
      "cost $4.00 ≥ 80% of $5 budget",
    );
  });

  it("formats the token detail with the summed raw count and threshold percent", () => {
    // 500k + 400k = 900_000 → exactly 90% of the 1,000,000 cap → warn band.
    const result = detectAnomalies(
      { exitCode: 0, tokensIn: 500_000, tokensOut: 400_000 },
      LIMITS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "warn",
    });
    expect(result.anomalies[0].detail).toBe(
      "900000 tokens ≥ 80% of 1000000 budget",
    );
  });
});
