import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  DEFAULT_ANOMALY_LIMITS,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Pure function over a persisted agent-run record. No I/O, no clock — fully
// deterministic. Covers: clean run, each anomaly kind, severity escalation at
// the limit boundary, max-severity aggregation, and malformed input.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies", () => {
  it("returns no anomalies and 'info' severity for a healthy run", () => {
    const result = detectAnomalies(
      { exitCode: 0, costUsd: 1, durationMs: 60_000, tokensIn: 100, tokensOut: 100 },
      LIMITS,
    );
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("flags a non-zero exit as a 'warn' non-zero-exit anomaly", () => {
    const result = detectAnomalies({ exitCode: 137 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "non-zero-exit",
      severity: "warn",
    });
    expect(result.anomalies[0].detail).toContain("137");
    expect(result.severity).toBe("warn");
  });

  it("flags cost in the near-limit band (>= 80%, < 100%) as 'warn'", () => {
    // 0.8 * 5 = 4.0 → exactly at the near threshold, below the hard cap.
    const result = detectAnomalies({ exitCode: 0, costUsd: 4 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    expect(result.severity).toBe("warn");
  });

  it("escalates cost at/over the hard cap to 'critical'", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 5 }, LIMITS);
    expect(result.anomalies[0].severity).toBe("critical");
    expect(result.severity).toBe("critical");
  });

  it("sums tokensIn + tokensOut for the token near-limit check", () => {
    // 600k + 400k = 1,000,000 → exactly the cap → critical.
    const result = detectAnomalies(
      { exitCode: 0, tokensIn: 600_000, tokensOut: 400_000 },
      LIMITS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "critical" });
  });

  it("does not flag tokens when the total is below the near threshold", () => {
    const result = detectAnomalies(
      { exitCode: 0, tokensIn: 100_000, tokensOut: 100_000 },
      LIMITS,
    );
    expect(result.anomalies).toEqual([]);
  });

  it("reports max severity across multiple anomalies", () => {
    const result = detectAnomalies(
      { exitCode: 1, costUsd: 10, durationMs: 5_000 },
      LIMITS,
    );
    // non-zero-exit (warn) + cost over cap (critical) → critical overall.
    expect(result.severity).toBe("critical");
    expect(result.anomalies.map((a) => a.kind).sort()).toEqual([
      "near-limit",
      "non-zero-exit",
    ]);
  });

  it("treats null/non-object input as a clean run", () => {
    expect(detectAnomalies(null).severity).toBe("info");
    expect(detectAnomalies(undefined).anomalies).toEqual([]);
    expect(detectAnomalies(42 as unknown).anomalies).toEqual([]);
  });

  it("ignores missing/non-numeric fields rather than throwing", () => {
    const result = detectAnomalies({ exitCode: "bad", costUsd: null }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("applies DEFAULT_ANOMALY_LIMITS when none are provided", () => {
    // Default maxCostUsd is 5; $4.50 is in the warn band.
    const result = detectAnomalies({ exitCode: 0, costUsd: 4.5 });
    expect(DEFAULT_ANOMALY_LIMITS.maxCostUsd).toBe(5);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
  });
});
