import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the token near-limit *warn* band of detectAnomalies.
// The base anomaly.test.ts only trips the token branch at exactly the cap
// (600k + 400k = 1,000,000 → critical) and below the near threshold (no
// anomaly). Unlike cost and duration — which each assert both the warn band
// and the critical escalation — the token branch's "near but under cap → warn"
// severity is never asserted. This fills that symmetry gap.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — token near-limit", () => {
  it("flags summed tokens in the near band (>= 80%, < 100%) as 'warn'", () => {
    // 0.8 * 1_000_000 = 800_000 → exactly the near threshold, below the cap.
    // Split across in/out to also confirm the warn classification uses the sum.
    const result = detectAnomalies(
      { exitCode: 0, tokensIn: 500_000, tokensOut: 300_000 },
      LIMITS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    expect(result.anomalies[0].detail).toBe("800000 tokens ≥ 80% of 1000000 budget");
    expect(result.severity).toBe("warn");
  });

  it("does not escalate to 'critical' for tokens one below the cap", () => {
    const result = detectAnomalies({ exitCode: 0, tokensIn: 999_999 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].severity).toBe("warn");
    expect(result.severity).toBe("warn");
  });

  it("does not flag tokens one below the near threshold", () => {
    const result = detectAnomalies({ exitCode: 0, tokensIn: 799_999 }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });
});
