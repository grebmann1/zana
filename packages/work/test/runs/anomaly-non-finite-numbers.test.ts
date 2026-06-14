import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// detectAnomalies gates each numeric dimension on `typeof x === "number"`, which
// is TRUE for the non-finite IEEE-754 values NaN and Infinity. Those values are
// realistic in a persisted record (a cost calc that divided by zero, an
// unbounded duration). Every other anomaly test feeds finite numbers, so the
// behavior for non-finite inputs is unpinned. This locks the current contract:
//   - NaN never satisfies a `>=` comparison, so a NaN field is silently treated
//     as a clean dimension (no anomaly, no throw).
//   - Infinity is >= any finite cap, so it trips a *critical* near-limit.
// Pure function — fully deterministic, no clock, no I/O.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — non-finite numeric fields", () => {
  it("treats NaN cost/duration/token fields as a clean run (NaN fails every >= check)", () => {
    const result = detectAnomalies(
      {
        exitCode: 0,
        costUsd: NaN,
        durationMs: NaN,
        tokensIn: NaN,
        tokensOut: NaN,
      },
      LIMITS,
    );
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("flags Infinity cost as a critical near-limit and renders 'Infinity' in the detail", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: Infinity }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
    // (Infinity).toFixed(2) === "Infinity"
    expect(result.anomalies[0].detail).toContain("$Infinity");
    expect(result.severity).toBe("critical");
  });

  it("flags Infinity duration and Infinity token sum as critical near-limits", () => {
    const dur = detectAnomalies({ exitCode: 0, durationMs: Infinity }, LIMITS);
    expect(dur.anomalies).toHaveLength(1);
    expect(dur.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });

    // tokensIn + tokensOut === Infinity, which is > 0 and >= the cap.
    const tok = detectAnomalies(
      { exitCode: 0, tokensIn: Infinity, tokensOut: 0 },
      LIMITS,
    );
    expect(tok.anomalies).toHaveLength(1);
    expect(tok.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
  });
});
