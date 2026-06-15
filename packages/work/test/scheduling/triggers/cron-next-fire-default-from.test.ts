// nextFireAt() default `from` parameter — the branch where no anchor Date is
// passed and the function falls back to `from = new Date()`.
//
// Every other nextFireAt() test passes an explicit `from`. The two single-arg
// calls in triggers.test.ts use INVALID expressions ("99 * * * *", "") that
// short-circuit to null inside validate() before the default `from` is read.
// This file covers the remaining branch: a VALID expression with no anchor,
// which must compute a real next-fire timestamp relative to the current clock.
//
// Determinism: "* * * * *" fires every minute, so the next fire is the next
// whole-minute boundary — always strictly after the call and at most ~60s
// ahead, regardless of when the test runs. No timer faking needed.

import { describe, it, expect } from "vitest";
import { nextFireAt } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("nextFireAt() — default `from` (current time)", () => {
  it("computes a valid future ISO timestamp from the real clock for '* * * * *'", () => {
    const before = Date.now();
    const next = nextFireAt("* * * * *"); // no `from` → defaults to new Date()
    expect(next).toBeTruthy();

    const ts = Date.parse(next!);
    expect(Number.isNaN(ts)).toBe(false); // parseable ISO-8601
    expect(ts).toBeGreaterThan(before); // strictly in the future
    // next whole-minute boundary is at most one minute (+1s slack) ahead
    expect(ts - before).toBeLessThanOrEqual(61_000);
    // landed on a clean minute boundary (seconds/millis zeroed)
    expect(ts % 60_000).toBe(0);
  });
});
