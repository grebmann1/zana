import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Robustness of the token sum when a record carries only ONE of the two token
// fields, or a non-numeric one. detectAnomalies computes:
//   (typeof tokensIn  === "number" ? tokensIn  : 0)
// + (typeof tokensOut === "number" ? tokensOut : 0)
// The base suites cover `tokensIn` alone (anomaly-token-near-limit.test.ts) and
// both-present (anomaly.test.ts), but never the symmetric `tokensOut`-only path
// nor a non-numeric field. The docstring promises "older records may lack some"
// fields — without the `? : 0` guard, `"garbage" + 900_000` would string-concat
// (→ NaN comparisons / wrong anomaly), so this locks the coercion contract.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — partial / non-numeric token fields", () => {
  it("flags tokensOut alone (tokensIn absent) when it crosses the near threshold", () => {
    const result = detectAnomalies({ exitCode: 0, tokensOut: 850_000 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    expect(result.anomalies[0].detail).toBe("850000 tokens ≥ 80% of 1000000 budget");
    expect(result.severity).toBe("warn");
  });

  it("coerces a non-numeric tokensIn to 0 instead of string-concatenating with tokensOut", () => {
    // Without the `typeof … ? … : 0` guard this would be "garbage" + 900000,
    // producing a string the >= comparison can't classify correctly.
    const result = detectAnomalies(
      { exitCode: 0, tokensIn: "garbage" as unknown as number, tokensOut: 900_000 },
      LIMITS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "near-limit", severity: "warn" });
    // Sum is exactly 900000 (tokensIn contributes 0), not a NaN/concat artifact.
    expect(result.anomalies[0].detail).toBe("900000 tokens ≥ 80% of 1000000 budget");
  });

  it("does not flag when the only present token field is below the near threshold", () => {
    const result = detectAnomalies({ exitCode: 0, tokensOut: 799_999 }, LIMITS);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });
});
