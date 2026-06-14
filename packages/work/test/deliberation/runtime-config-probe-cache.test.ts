// Regression pin for probeCacheTtlMs in deliberation/runtime-config.ts.
//
// The source comment states: "0 disables caching; default 5 min."
// These tests pin:
//   1. The exact default (300_000 ms = 5 min).
//   2. That 0 is accepted as a valid value and round-trips cleanly (the
//      disabling sentinel must NOT be clamped, coerced, or rejected).
//   3. That the value can be freely overridden and that resetRuntimeConfig
//      always restores the 5-min default, even after a 0-sentinel cycle.

import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

const PROBE_CACHE_TTL_DEFAULT_MS = 300_000; // 5 minutes

beforeEach(() => {
  rc.resetRuntimeConfig();
});

describe("probeCacheTtlMs — probe-cache TTL and the 0-disables-caching sentinel", () => {
  it("default is exactly 5 minutes (300_000 ms)", () => {
    expect(rc.getRuntimeConfig().probeCacheTtlMs).toBe(PROBE_CACHE_TTL_DEFAULT_MS);
  });

  it("0 is accepted as the disable-caching sentinel and survives round-trip", () => {
    rc.setRuntimeConfig({ probeCacheTtlMs: 0 });
    // Must be exactly 0 — not coerced to 1 / null / undefined / default.
    expect(rc.getRuntimeConfig().probeCacheTtlMs).toBe(0);
  });

  it("resetRuntimeConfig restores 5-min default after the 0-sentinel", () => {
    rc.setRuntimeConfig({ probeCacheTtlMs: 0 });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().probeCacheTtlMs).toBe(PROBE_CACHE_TTL_DEFAULT_MS);
  });

  it("can be set to an arbitrary positive TTL", () => {
    rc.setRuntimeConfig({ probeCacheTtlMs: 60_000 }); // 1 minute
    expect(rc.getRuntimeConfig().probeCacheTtlMs).toBe(60_000);
  });

  it("overriding probeCacheTtlMs leaves all other fields at their defaults", () => {
    rc.setRuntimeConfig({ probeCacheTtlMs: 0 });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.probeTimeoutMs).toBe(120_000);
    expect(cfg.probeRawMaxBytes).toBe(1024);
    expect(cfg.escalationStrategy).toBe("human");
  });

  it("multiple 0-sentinel / reset cycles all converge to the 5-min default", () => {
    for (let i = 0; i < 3; i++) {
      rc.setRuntimeConfig({ probeCacheTtlMs: 0 });
      rc.resetRuntimeConfig();
      expect(rc.getRuntimeConfig().probeCacheTtlMs).toBe(PROBE_CACHE_TTL_DEFAULT_MS);
    }
  });
});
