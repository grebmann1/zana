// Day-of-week RANGE coverage for nextFireAt() in cron.ts.
//
// Existing cron tests cover the Sunday dual-encoding (dow 0 vs 7) and single
// values, but NOTHING exercises a weekday RANGE (`1-5`) through nextFireAt().
// The "business hours, weekdays only" schedule `0 9 * * 1-5` is the canonical
// real-world case, and its defining invariant — Saturday (dow 6) and Sunday
// (dow 0) must be SKIPPED — has no regression guard.
//
// node-cron is NOT mocked: `0 9 * * 1-5` is a real, valid 5-field cron.
//
// Timezone note: nextFireAt() derives all wall-clock fields (hour/minute/day)
// in LOCAL time consistently, so the result of `0 9 * * 1-5` is ALWAYS a local
// weekday at 09:00 regardless of host timezone — the invariant below holds in
// any TZ. We seed seven start points 24h apart so that, whatever the host TZ,
// at least one start lands on a local weekend, exercising the skip path.

import { describe, it, expect } from "vitest";
import { nextFireAt } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("nextFireAt() — weekday range '0 9 * * 1-5' excludes weekends", () => {
  // 2026-06-13 is a Saturday (UTC); the seven daily-spaced starts below span a
  // full week, so every local weekday AND both weekend days appear as a start.
  const BASE = new Date("2026-06-13T00:00:00.000Z");

  it("every resolved fire lands on a weekday (dow 1-5) at exactly 09:00", () => {
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const from = new Date(BASE.getTime() + dayOffset * 86_400_000);
      const next = nextFireAt("0 9 * * 1-5", from);
      expect(next).toBeTruthy();

      const d = new Date(next!);
      const dow = d.getDay();
      // Core invariant: never Saturday (6) or Sunday (0).
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
      // Time-of-day must match the minute/hour fields.
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
      // Must be strictly in the future relative to `from`.
      expect(d.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});
