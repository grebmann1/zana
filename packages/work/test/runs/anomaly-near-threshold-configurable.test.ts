import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// The `nearThreshold` field is documented as overridable per-call
// ("Override per-call if needed"). Every other anomaly test pins it to the
// default 0.8; this one verifies the threshold itself actually drives the
// near-limit band — the same record is clean under a lax threshold and
// flagged under a strict one. Pure function, fully deterministic.

function limits(nearThreshold: number): AnomalyLimits {
  return {
    maxCostUsd: 5,
    maxDurationMs: 10 * 60 * 1000,
    maxTokens: 1_000_000,
    nearThreshold,
  };
}

describe("detectAnomalies — configurable nearThreshold", () => {
  // $3 is 60% of the $5 cap: between a strict 0.5 band and a lax 0.8 band.
  const record = { exitCode: 0, costUsd: 3 };

  it("does NOT flag a run below a lax threshold", () => {
    // 0.8 * 5 = $4.0 band start; $3 < $4 → clean.
    const result = detectAnomalies(record, limits(0.8));
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("flags the same run as 'warn' under a stricter threshold", () => {
    // 0.5 * 5 = $2.5 band start; $2.5 <= $3 < $5 → warn near-limit.
    const result = detectAnomalies(record, limits(0.5));
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "warn",
    });
    expect(result.severity).toBe("warn");
  });

  it("embeds the rounded custom threshold percent in the detail string", () => {
    const result = detectAnomalies(record, limits(0.5));
    // Math.round(0.5 * 100) = 50 → "50%".
    expect(result.anomalies[0].detail).toContain("50%");
  });
});
