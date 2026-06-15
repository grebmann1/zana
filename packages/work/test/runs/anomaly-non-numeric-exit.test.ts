import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the `typeof exit === "number"` guard on the
// non-zero-exit branch. Existing tests cover numeric codes (137, -1, 1) and a
// clean exit of 0, but none pin the behavior when `exitCode` arrives as a
// non-numeric value (e.g. the string "1" from a loosely-typed/legacy run
// record). The guard must treat it as absent — NOT flag it and NOT throw —
// otherwise a truthy string would be mis-classified. Pure function: fully
// deterministic, no clock/IO.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — non-numeric exitCode", () => {
  it("ignores a string exitCode rather than flagging a non-zero-exit", () => {
    // A truthy, non-zero-looking string must NOT trip the numeric guard.
    const result = detectAnomalies(
      { exitCode: "1" as unknown as number },
      LIMITS,
    );
    expect(result.anomalies).toHaveLength(0);
    expect(result.severity).toBe("info");
  });
});
