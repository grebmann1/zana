import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Each anomaly carries its OWN severity; the result-level `severity` is only the
// max across them. A `non-zero-exit` is always "warn" and must NOT be dragged up
// to "critical" just because an accompanying near-limit anomaly is critical.
// The existing multi-anomaly test only asserts the aggregate severity and the
// (sorted) set of kinds — it never pins the individual severities or the order
// in which the two kinds are emitted.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — per-anomaly severity is independent of the aggregate", () => {
  it("keeps non-zero-exit at 'warn' (emitted first) while a co-occurring over-cap cost is 'critical'", () => {
    const result = detectAnomalies({ exitCode: 1, costUsd: 10 }, LIMITS);

    // Source order: non-zero-exit is pushed before any near-limit check.
    expect(result.anomalies.map((a) => a.kind)).toEqual([
      "non-zero-exit",
      "near-limit",
    ]);

    const exitAnomaly = result.anomalies.find((a) => a.kind === "non-zero-exit");
    const costAnomaly = result.anomalies.find((a) => a.kind === "near-limit");

    // The exit anomaly stays "warn" even though the cost anomaly is "critical".
    expect(exitAnomaly?.severity).toBe("warn");
    expect(costAnomaly?.severity).toBe("critical");

    // Aggregate is the max of the two.
    expect(result.severity).toBe("critical");
  });
});
