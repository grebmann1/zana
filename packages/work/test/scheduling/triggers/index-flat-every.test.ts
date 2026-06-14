// Flat (unwrapped) `every` shorthand — the legacy top-level field path.
//
// readScheduleBlock() resolves the `every` shorthand from two places:
//     const every = block.every || schedule?.every || null;
// Every existing `every` test wraps the field in a `schedule: { every }`
// block, so they all exercise only the `block.every` half. Flat `cron` and
// flat `intervalMs` legacy fields are each pinned (triggers.test.ts and
// index-field-precedence.test.ts), but flat `every` is not — a refactor that
// dropped the `schedule?.every` fallback would break legacy flat-field
// schedules while every current test stayed green. This pins that fallback.

import { describe, it, expect } from "vitest";
import {
  pickBackend,
  computeNextRunAt,
} from "@zana-ai/work/src/scheduling/triggers/index.ts";
import * as intervalBackend from "@zana-ai/work/src/scheduling/triggers/interval.ts";

describe("flat top-level `every` shorthand (no schedule wrapper)", () => {
  it("pickBackend resolves flat `every` to the interval backend with converted ms", () => {
    // "5m" → 300_000 ms, taken from the flat field (no `schedule` block).
    const picked = pickBackend({ every: "5m" });
    expect(picked).not.toBeNull();
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(300_000);
    expect(picked!.start).toBe(intervalBackend.start);
  });

  it("computeNextRunAt honors flat `every`, returning from + intervalMs", () => {
    const from = new Date("2026-06-14T00:00:00.000Z");
    const next = computeNextRunAt({ every: "10m" }, from);
    expect(next).toBe("2026-06-14T00:10:00.000Z");
  });
});
