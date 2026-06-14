import { describe, it, expect } from "vitest";

import { detectAnomalies } from "@zana-ai/work/src/runs/anomaly.ts";

// The input guard is `!record || typeof record !== "object"`. Arrays are
// truthy AND `typeof [] === "object"`, so they slip past the guard (unlike
// null/undefined/number, which are covered in anomaly.test.ts) and fall
// through to the field reads. Since an array carries no numeric
// costUsd/durationMs/token fields, the result must still be a clean "info"
// run rather than a throw or a spurious anomaly. This pins that boundary.

describe("detectAnomalies — array input", () => {
  it("treats an array record as a clean run (no anomalies, 'info')", () => {
    const result = detectAnomalies([] as unknown);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });

  it("does not read numeric anomaly fields off array elements", () => {
    // An array whose elements happen to look like records must not be
    // mistaken for a single run; index access (record.costUsd) is undefined.
    const result = detectAnomalies([{ costUsd: 999, exitCode: 1 }] as unknown);
    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });
});
