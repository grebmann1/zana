import { describe, it, expect } from "vitest";

import { DEFAULT_ANOMALY_LIMITS } from "@zana-ai/work/src/runs/anomaly.ts";

// Contract guard for the exported DEFAULT_ANOMALY_LIMITS. These defaults are a
// documented contract — the duration cap is tuned to match core's
// AGENT_TIMEOUT_MS (10 min) and the cost/token ceilings + nearThreshold are
// what every detectAnomalies() call falls back to. The base suite only asserts
// maxCostUsd; a regression silently retuning the duration cap, token ceiling,
// or near band would otherwise slip through. Pure data assertion — no I/O.

describe("DEFAULT_ANOMALY_LIMITS contract", () => {
  it("pins the documented default ceilings and near threshold", () => {
    expect(DEFAULT_ANOMALY_LIMITS).toEqual({
      maxCostUsd: 5,
      maxDurationMs: 10 * 60 * 1000, // 10 min — matches AGENT_TIMEOUT_MS default
      maxTokens: 1_000_000,
      nearThreshold: 0.8,
    });
  });

  it("uses a nearThreshold strictly between 0 and 1 (a fraction of the cap)", () => {
    expect(DEFAULT_ANOMALY_LIMITS.nearThreshold).toBeGreaterThan(0);
    expect(DEFAULT_ANOMALY_LIMITS.nearThreshold).toBeLessThan(1);
  });
});
