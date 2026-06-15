// runtime-config-nested-defaults-aliasing.test.ts
//
// Pins a footgun that the existing idempotency suite does NOT cover.
//
// `resetRuntimeConfig()` does `active = { ...DEFAULTS }` — a SHALLOW clone.
// Top-level scalar fields are copied by value, so mutating
// `getRuntimeConfig().defaultRounds` cannot corrupt DEFAULTS (and reset
// always restores it — see runtime-config-reset-idempotency.test.ts).
//
// The nested `generalistSeat` object is different: the shallow spread copies
// the REFERENCE, so `active.generalistSeat === DEFAULTS.generalistSeat`.
// Two consequences, both pinned here as the CURRENT contract:
//   1. The same nested object identity is handed out across resets.
//   2. In-place mutation of that nested object leaks into DEFAULTS and
//      therefore SURVIVES a subsequent resetRuntimeConfig() — reset cannot
//      heal it because DEFAULTS itself was corrupted.
//
// Callers must treat getRuntimeConfig() as read-only and never mutate the
// nested object in place; use setRuntimeConfig({ generalistSeat: {...} }),
// which REPLACES the reference and leaves DEFAULTS intact.
//
// If runtime-config is ever hardened to deep-clone (or freeze) DEFAULTS on
// reset, these expectations should flip — that is an intentional contract
// change, and this test is the tripwire that flags it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

describe("runtime-config — nested generalistSeat aliases DEFAULTS (shallow-clone footgun)", () => {
  beforeEach(() => {
    rc.resetRuntimeConfig();
  });

  afterEach(() => {
    // Heal any DEFAULTS corruption this suite deliberately induces so it
    // cannot bleed into sibling test files via the shared module singleton.
    rc.setRuntimeConfig({ generalistSeat: { enabled: true, profileId: "researcher" } });
    rc.resetRuntimeConfig();
  });

  it("hands out the same nested-object identity across resets", () => {
    const seatA = rc.getRuntimeConfig().generalistSeat;
    rc.resetRuntimeConfig();
    const seatB = rc.getRuntimeConfig().generalistSeat;
    // Shallow clone => the nested reference is shared with DEFAULTS, so it is
    // identical across resets (not a fresh object each time).
    expect(seatB).toBe(seatA);
  });

  it("setRuntimeConfig with a fresh nested object does NOT alias DEFAULTS", () => {
    const before = rc.getRuntimeConfig().generalistSeat;
    rc.setRuntimeConfig({ generalistSeat: { enabled: false, profileId: "x" } });
    const after = rc.getRuntimeConfig().generalistSeat;
    // setRuntimeConfig REPLACES the reference — the new value is a distinct
    // object, and the original DEFAULTS-backed one is untouched.
    expect(after).not.toBe(before);
    expect(before).toEqual({ enabled: true, profileId: "researcher" });
    // And reset restores the pristine default object.
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().generalistSeat).toEqual({ enabled: true, profileId: "researcher" });
  });

  it("in-place mutation of the nested object corrupts DEFAULTS and survives reset", () => {
    // Readonly is a compile-time-only guarantee; JS permits the mutation.
    (rc.getRuntimeConfig() as any).generalistSeat.enabled = false;
    // Reset cannot heal it: active.generalistSeat WAS DEFAULTS.generalistSeat,
    // so DEFAULTS.generalistSeat.enabled is now false too.
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().generalistSeat.enabled).toBe(false);
  });
});
