import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  type AnomalyLimits,
} from "@zana-ai/work/src/runs/anomaly.ts";

// Focused coverage for the human-readable `detail` string on the
// non-zero-exit branch of detectAnomalies. anomaly-detail-strings.test.ts
// deliberately pins only the cost and token detail text, and
// anomaly-negative-exit.test.ts asserts merely `.toContain("-1")`. Nothing
// pins the exact `agent exited with code N` format an operator actually sees,
// so a refactor of that template would slip through. Pure function — fully
// deterministic, no clock/IO.

const LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000,
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

describe("detectAnomalies — non-zero-exit detail string", () => {
  it("renders the exact `agent exited with code N` text with the raw code", () => {
    // 137 = SIGKILL (128 + 9); a common headless-agent failure code.
    const result = detectAnomalies({ exitCode: 137 }, LIMITS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "non-zero-exit",
      severity: "warn",
    });
    expect(result.anomalies[0].detail).toBe("agent exited with code 137");
  });
});
