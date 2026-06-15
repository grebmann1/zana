import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Degenerate boundary of the configurable `nearThreshold`: when it is set to
// 1.0 the "near" band [nearThreshold * cap, cap) collapses to empty. Every
// other anomaly test uses a fractional threshold (default 0.8, or the
// lax/strict 0.8/0.5 pair in anomaly-near-threshold-configurable.test.ts), so
// the warn band has always been non-empty. With threshold 1.0 the only way to
// trip a near-limit is to reach the cap itself — which the implementation
// always classifies as `critical` (`value >= cap`). So a run just under the
// cap is clean, and the first thing that flags is necessarily critical, never
// warn. This pins that interaction plus the "100%" detail rendering.
// Pure function — fully deterministic, no clock/IO.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 1.0,
};

describe("detectAnomalies — nearThreshold 1.0 collapses the warn band", () => {
  it("treats a run just under the cap as clean (no warn band exists)", () => {
    // $4.99 is 99.8% of the $5 cap — would be a warn near-limit at the
    // default 0.8 threshold, but with threshold 1.0 the band starts at $5.
    const result = detectAnomalies({ exitCode: 0, costUsd: 4.99 }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("flags a run at the cap as critical (never warn) with a 100% detail", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 5 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
    // Math.round(1.0 * 100) = 100 → "100% of $5 budget".
    expect(result.anomalies[0].detail).toBe(
      "cost $5.00 ≥ 100% of $5 budget",
    );
    expect(result.severity).toBe("critical");
  });
});
