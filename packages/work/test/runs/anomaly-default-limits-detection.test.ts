import { describe, it, expect } from "vitest";

import { detectAnomalies } from "@zana-ai/work/src/runs/anomaly.ts";

// Every other detection test passes an EXPLICIT limits object, and the only
// single-arg detectAnomalies() calls in the suite use inputs (null/undefined/
// 42/[]) that short-circuit before any limit math runs. So nothing actually
// exercises the `limits = DEFAULT_ANOMALY_LIMITS` default parameter against
// real detection. Production callers invoke detectAnomalies(record) with one
// arg — if that default binding regressed (e.g. became undefined/{}), every
// existing test would stay green while real callers crashed on
// `limits.nearThreshold` / `limits.maxCostUsd`. This pins that the defaults
// (maxCostUsd 5, nearThreshold 0.8) drive detection when limits is omitted.
// Pure function, no I/O — deterministic.

describe("detectAnomalies — default limits drive detection when omitted", () => {
  it("escalates to 'critical' at the default $5 cost cap with no explicit limits", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 6 });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "critical",
    });
    expect(result.severity).toBe("critical");
  });

  it("flags 'warn' at the default 0.8 near band ($4 = 80% of $5) with no explicit limits", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 4 });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      kind: "near-limit",
      severity: "warn",
    });
    expect(result.severity).toBe("warn");
  });

  it("stays 'info' just below the default near band ($3.99 < 80% of $5)", () => {
    const result = detectAnomalies({ exitCode: 0, costUsd: 3.99 });

    expect(result.anomalies).toEqual([]);
    expect(result.severity).toBe("info");
  });
});
