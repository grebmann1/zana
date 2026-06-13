// runtime-config-shallow-merge-nested.test.ts
//
// Pins the documented merge semantic of setRuntimeConfig: it shallow-merges
// the partial over `active` (`{ ...active, ...partial }`). The existing suite
// only ever supplies a FULL `generalistSeat` object, so the footgun where a
// PARTIAL nested object REPLACES (not deep-merges) the whole nested value —
// silently dropping sibling keys like `profileId` — was previously untested.
//
// This is a real regression surface: a caller writing
//   setRuntimeConfig({ generalistSeat: { enabled: false } })
// expecting profileId to be preserved would instead get profileId=undefined.

import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

describe("setRuntimeConfig — shallow merge of nested generalistSeat", () => {
  beforeEach(() => {
    rc.resetRuntimeConfig();
  });

  it("a partial nested generalistSeat REPLACES the object, dropping unsupplied sibling keys", () => {
    // default is { enabled: true, profileId: "researcher" }
    rc.setRuntimeConfig({ generalistSeat: { enabled: false } as any });
    const seat = rc.getRuntimeConfig().generalistSeat;
    expect(seat.enabled).toBe(false);
    // profileId is gone — shallow merge replaced the whole nested object.
    expect(seat.profileId).toBeUndefined();
  });

  it("top-level sibling fields are unaffected by a nested-object override", () => {
    rc.setRuntimeConfig({ generalistSeat: { enabled: false, profileId: "x" } });
    // generalistSeatThreshold is a separate top-level key — untouched.
    expect(rc.getRuntimeConfig().generalistSeatThreshold).toBe(3);
    expect(rc.getRuntimeConfig().defaultRounds).toBe(2);
  });
});
