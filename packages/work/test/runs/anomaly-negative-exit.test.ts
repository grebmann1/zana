import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Regression guard: a negative exitCode is still a non-zero exit. Some runtimes
// report negative codes for signal-killed processes (e.g. -1), and the
// `exit !== 0` check must flag them just like a positive failure code. Existing
// anomaly tests only exercise positive codes (1, 137), so this pins the
// negative branch.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — negative exit code", () => {
  it("flags a negative exitCode as a 'warn' non-zero-exit anomaly", () => {
    const result = detectAnomalies({ exitCode: -1 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "non-zero-exit",
      severity: "warn",
    });
    expect(result.anomalies[0].detail).toContain("-1");
    expect(result.severity).toBe("warn");
  });
});
