import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the cost near-limit *critical* branch detail string.
// anomaly-detail-strings.test.ts pins the cost WARN detail exactly
// ("cost $4.00 ≥ 80% of $5 budget"), and duration/token criticals are exact-
// asserted elsewhere — but the cost CRITICAL detail is only ever `.toContain`'d
// (e.g. exit-with-all-near-limits checks "cost $6.00"), never locked in full.
// Two subtle behaviors go unpinned as a result:
//   1. The detail percent reflects `nearThreshold` (80%), NOT the actual
//      overage — an over-cap run still reads "≥ 80% of $5 budget".
//   2. `.toFixed(2)` is applied to the over-cap value (6 → "6.00").
// It also locks the exact-equality boundary of the severity ternary
// (`cost >= maxCostUsd` → critical) at cost === maxCostUsd.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — cost critical detail string", () => {
  it("renders an over-cap cost as 'critical' with the nearThreshold percent (not the overage)", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 6 }, LIMITS);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
    // Percent is the threshold (80%), and 6 is formatted via toFixed(2).
    expect(result.anomalies[0].detail).toBe("cost $6.00 ≥ 80% of $5 budget");
    expect(result.severity).toBe("critical");
  });

  it("escalates to 'critical' at exactly the hard cap (>= is inclusive)", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 5 }, LIMITS);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
    expect(result.anomalies[0].detail).toBe("cost $5.00 ≥ 80% of $5 budget");
    expect(result.severity).toBe("critical");
  });
});
