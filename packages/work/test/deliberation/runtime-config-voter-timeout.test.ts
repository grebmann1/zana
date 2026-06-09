// Regression pin for voterTimeoutMs in deliberation/runtime-config.ts.
//
// The default was bumped from 10 minutes to 20 minutes after the May 2026
// real-Claude smoke test caught all three voters timing out on large
// codebases.  This file pins:
//   1. The exact default (1_200_000 ms = 20 min) — guards against an
//      accidental revert to the old 600_000 ms (10 min) value.
//   2. That setRuntimeConfig can lower or raise the ceiling for tests
//      that need a tighter or looser timeout.
//   3. That resetRuntimeConfig restores the correct 20-min value after
//      any override, regardless of how many times the cycle repeats.

import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

const VOTER_TIMEOUT_DEFAULT_MS = 20 * 60 * 1000; // 1_200_000 ms
const OLD_VOTER_TIMEOUT_MS = 10 * 60 * 1000;     // 600_000 ms — must NOT be the default

beforeEach(() => {
  rc.resetRuntimeConfig();
});

describe("voterTimeoutMs — regression pin for the 20-min bump", () => {
  it("default is exactly 20 min (1_200_000 ms), NOT the old 10-min value", () => {
    const cfg = rc.getRuntimeConfig();
    expect(cfg.voterTimeoutMs).toBe(VOTER_TIMEOUT_DEFAULT_MS);
    // Explicit guard: ensure the pre-bump value is no longer the default.
    expect(cfg.voterTimeoutMs).not.toBe(OLD_VOTER_TIMEOUT_MS);
  });

  it("can be lowered for tests that use a tight timeout", () => {
    rc.setRuntimeConfig({ voterTimeoutMs: 5_000 });
    expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(5_000);
  });

  it("can be raised above the default for especially large codebases", () => {
    rc.setRuntimeConfig({ voterTimeoutMs: 30 * 60 * 1000 });
    expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("resetRuntimeConfig restores the 20-min default after a lower override", () => {
    rc.setRuntimeConfig({ voterTimeoutMs: 1_000 });
    expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(1_000);
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(VOTER_TIMEOUT_DEFAULT_MS);
  });

  it("resetRuntimeConfig restores the 20-min default after a higher override", () => {
    rc.setRuntimeConfig({ voterTimeoutMs: 60 * 60 * 1000 }); // 1 hour
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(VOTER_TIMEOUT_DEFAULT_MS);
  });

  it("overriding voterTimeoutMs leaves all other fields at their defaults", () => {
    rc.setRuntimeConfig({ voterTimeoutMs: 999 });
    const cfg = rc.getRuntimeConfig();
    // Spot-check a handful of unrelated fields.
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.escalationStrategy).toBe("human");
    expect(cfg.occMaxRetries).toBe(3);
    expect(cfg.generalistSeat).toEqual({ enabled: true, profileId: "researcher" });
  });

  it("multiple set/reset cycles all converge to the 20-min default", () => {
    for (const ms of [500, 2_000, OLD_VOTER_TIMEOUT_MS, 999_999]) {
      rc.setRuntimeConfig({ voterTimeoutMs: ms });
      rc.resetRuntimeConfig();
      expect(rc.getRuntimeConfig().voterTimeoutMs).toBe(VOTER_TIMEOUT_DEFAULT_MS);
    }
  });
});
