import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the duration near-limit branch of detectAnomalies.
// The base anomaly.test.ts exercises cost / tokens / exit but never trips the
// durationMs branch (its multi-anomaly case passes 5_000ms, below threshold),
// so the warn band, critical escalation, and "Ns ≥ … cap" detail string are
// untested. Pure function — fully deterministic, no clock.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000, // 600_000ms
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — duration near-limit", () => {
  it("flags duration in the near band (>= 80%, < 100%) as 'warn' with a seconds detail", () => {
    // 0.8 * 600_000 = 480_000ms → exactly the near threshold, below the cap.
    const result = detectAnomalies({ exitCode: 0, durationMs: 480_000 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    // 480_000ms → 480s, cap 600_000ms → 600s.
    expect(result.anomalies[0].detail).toBe("duration 480s ≥ 80% of 600s cap");
    expect(result.severity).toBe("warn");
  });

  it("escalates duration at/over the hard cap to 'critical'", () => {
    const result = detectAnomalies({ exitCode: 0, durationMs: 600_000 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "critical" });
    expect(result.severity).toBe("critical");
  });

  it("does not flag duration below the near threshold", () => {
    const result = detectAnomalies({ exitCode: 0, durationMs: 479_999 }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });
});
