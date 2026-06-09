// Focused regression tests for the DEFAULTS isolation invariant of
// deliberation/runtime-config.ts.
//
// `resetRuntimeConfig()` does `active = { ...DEFAULTS }`.  If DEFAULTS were
// accidentally mutated (e.g. by an in-place Object.assign targeting the wrong
// reference), the second call to resetRuntimeConfig() would restore the
// mutated "defaults" rather than the true original values.  These tests pin
// that reset is always idempotent and that multiple set/reset cycles all
// converge to the same original defaults.

import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

const ORIGINAL_ROUNDS = 2;
const ORIGINAL_QUORUM = "majority";
const ORIGINAL_STRATEGY = "human";
const ORIGINAL_GENERALIST_SEAT = { enabled: true, profileId: "researcher" };
const ORIGINAL_THRESHOLD = 3;

beforeEach(() => {
  rc.resetRuntimeConfig();
});

describe("runtime-config DEFAULTS isolation — repeated reset/set cycles", () => {
  it("two reset() calls in a row both produce the same defaults", () => {
    rc.resetRuntimeConfig();
    const first = rc.getRuntimeConfig();
    rc.resetRuntimeConfig();
    const second = rc.getRuntimeConfig();
    expect(first.defaultRounds).toBe(second.defaultRounds);
    expect(first.defaultQuorum).toBe(second.defaultQuorum);
    expect(first.escalationStrategy).toBe(second.escalationStrategy);
    expect(first.generalistSeatThreshold).toBe(second.generalistSeatThreshold);
  });

  it("set → reset → set → reset always restores original defaults", () => {
    // Cycle 1
    rc.setRuntimeConfig({ defaultRounds: 10, escalationStrategy: "judge" });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().defaultRounds).toBe(ORIGINAL_ROUNDS);
    expect(rc.getRuntimeConfig().escalationStrategy).toBe(ORIGINAL_STRATEGY);

    // Cycle 2 with different values
    rc.setRuntimeConfig({ defaultRounds: 99, defaultQuorum: "all", escalationStrategy: "hybrid" });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().defaultRounds).toBe(ORIGINAL_ROUNDS);
    expect(rc.getRuntimeConfig().defaultQuorum).toBe(ORIGINAL_QUORUM);
    expect(rc.getRuntimeConfig().escalationStrategy).toBe(ORIGINAL_STRATEGY);

    // Cycle 3 — generalist nested object
    rc.setRuntimeConfig({
      generalistSeat: { enabled: false, profileId: "custom" },
      generalistSeatThreshold: 99,
    });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().generalistSeat).toEqual(ORIGINAL_GENERALIST_SEAT);
    expect(rc.getRuntimeConfig().generalistSeatThreshold).toBe(ORIGINAL_THRESHOLD);
  });

  it("modifying the returned config snapshot does not corrupt DEFAULTS", () => {
    // getRuntimeConfig() returns Readonly<...> but the spread in setRuntimeConfig
    // only does a shallow copy of DEFAULTS.  If the returned snapshot were the
    // same reference as DEFAULTS (not a copy), external mutation would corrupt it.
    const snap = rc.getRuntimeConfig() as any;
    // Attempt to mutate — TypeScript forbids it but JS ignores Readonly at runtime.
    try { snap.defaultRounds = 999; } catch { /* strict mode / frozen obj */ }

    // Reset should still give the true original value regardless of what happened
    // to the snapshot.
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().defaultRounds).toBe(ORIGINAL_ROUNDS);
  });

  it("setRuntimeConfig(undefined) leaves config unchanged and reset still works", () => {
    rc.setRuntimeConfig(undefined as any);
    // Should still be at defaults
    expect(rc.getRuntimeConfig().defaultRounds).toBe(ORIGINAL_ROUNDS);
    // Reset after an undefined call must still restore cleanly
    rc.setRuntimeConfig({ defaultRounds: 7 });
    rc.setRuntimeConfig(undefined as any);
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().defaultRounds).toBe(ORIGINAL_ROUNDS);
  });

  it("five consecutive set/reset cycles always converge to defaults", () => {
    for (let i = 0; i < 5; i++) {
      rc.setRuntimeConfig({
        defaultRounds: 10 + i,
        escalationStrategy: i % 2 === 0 ? "judge" : "hybrid",
        generalistSeatThreshold: 10 + i,
      });
      rc.resetRuntimeConfig();
      const cfg = rc.getRuntimeConfig();
      expect(cfg.defaultRounds).toBe(ORIGINAL_ROUNDS);
      expect(cfg.escalationStrategy).toBe(ORIGINAL_STRATEGY);
      expect(cfg.generalistSeatThreshold).toBe(ORIGINAL_THRESHOLD);
      expect(cfg.generalistSeat).toEqual(ORIGINAL_GENERALIST_SEAT);
    }
  });
});
