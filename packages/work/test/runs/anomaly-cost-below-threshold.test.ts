import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the LOWER boundary of the cost near-limit branch.
// anomaly.test.ts asserts cost == threshold (4 → warn) and over-cap (5 →
// critical), and anomaly-near-threshold-configurable.test.ts uses a CUSTOM
// threshold — but the just-below-threshold "no anomaly" case under DEFAULT
// limits is never exercised for cost, even though duration (479_999) and
// tokens (799_999) both have such a guard. This locks the >= comparison so a
// future `>` regression on the cost branch is caught. Pure fn — deterministic.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — cost just below near-limit threshold", () => {
  it("does not flag cost just under the near threshold (0.8 * 5 = 4.0)", () => {
    // 3.99 < 4.0 → strictly below the near band, so no anomaly at all.
    const result = detectAnomalies({ exitCode: 0, costUsd: 3.99 }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("flags cost exactly at the near threshold as 'warn' (>= is inclusive)", () => {
    // Boundary sibling of the case above: 4.0 == threshold must trip 'warn',
    // proving the comparison is >= and not >.
    const result = detectAnomalies({ exitCode: 0, costUsd: 4 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    expect(result.severity).toBe("warn");
  });
});
