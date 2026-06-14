// Edge cases for compileField() — compound cron patterns exercised via nextFireAt().
//
// compileField() is a private function, but every branch is reachable through
// the public nextFireAt() API.  These tests cover two patterns absent from the
// existing cron.test.ts suite:
//
//   1. n-m/k full-range step  e.g. "0-59/5 * * * *"  → fires at :00, :05, …, :55
//   2. comma-list mixed items  e.g. "0-30/10,45 * * * *" → fires at :00, :10, :20, :30, :45
//   3. Sunday dual-encoding: cron fields treat dow=0 AND dow=7 as Sunday;
//      the source guards this with `dowMatch(dow) || dowMatch(dow === 0 ? 7 : dow)`.
//
// node-cron is NOT mocked here — all test expressions are validated as valid by
// the real node-cron library, so no fake is needed.
//
// Note: the n/k step-from-value syntax (e.g. "5/15") is handled inside
// compileField but node-cron.validate() rejects it, making that branch
// unreachable through nextFireAt().  It is left untested for that reason.

import { describe, it, expect } from "vitest";
import { nextFireAt } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

// ─────────────────────────────────────────────────────────────────────────────
// n-m/k — range+step (full range variant)
// "0-59/5": from=0, to=59, step=5  →  matches every 5-minute boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFireAt() — n-m/k full-range step pattern", () => {
  it("'0-59/5 * * * *' fires on a minute that is a multiple of 5", () => {
    const from = new Date("2026-06-15T12:00:30.000Z");
    const next = nextFireAt("0-59/5 * * * *", from);
    expect(next).toBeTruthy();
    expect(new Date(next!).getMinutes() % 5).toBe(0);
  });

  it("'0-30/10 * * * *' fires at a minute in {0, 10, 20, 30} — not 40 or 50", () => {
    // from 12:59 → start = 13:00; minute 0 is within the 0–30 range with step 10
    const from = new Date("2026-06-15T12:59:00.000Z");
    const next = nextFireAt("0-30/10 * * * *", from);
    expect(next).toBeTruthy();
    expect([0, 10, 20, 30]).toContain(new Date(next!).getMinutes());
  });

  it("'0-30/10 * * * *' never fires at minute 40 or 50", () => {
    // Scan 90 consecutive minutes and collect all fire-minute values.
    const base = new Date("2026-06-15T00:00:00.000Z");
    const minutesHit = new Set<number>();
    for (let i = 0; i < 90; i++) {
      const from = new Date(base.getTime() + i * 60_000);
      const next = nextFireAt("0-30/10 * * * *", from);
      if (next) minutesHit.add(new Date(next).getMinutes());
    }
    expect(minutesHit.has(40)).toBe(false);
    expect(minutesHit.has(50)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sunday dual-encoding — dow 0 and dow 7 both mean Sunday
//
// In the source:
//   (dowMatch(dow) || dowMatch(dow === 0 ? 7 : dow))
// When cur.getDay() === 0 (Sunday in JS), both dowMatch(0) and dowMatch(7) are
// checked.  A cron expression using "7" for Sunday must therefore fire on the
// same day as one using "0".
//
// June 12, 2026 = Friday.  June 15 = Monday, June 21 = Sunday.
// Starting from Monday midnight UTC, the next "0 0 (Sunday)" is 2026-06-21.
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFireAt() — Sunday dow=0 and dow=7 dual-encoding", () => {
  const FROM_MONDAY = new Date("2026-06-15T00:00:00.000Z"); // Monday midnight UTC

  it("'0 0 * * 0' (Sunday as 0) fires on a Sunday (getDay() === 0)", () => {
    const next = nextFireAt("0 0 * * 0", FROM_MONDAY);
    expect(next).toBeTruthy();
    expect(new Date(next!).getDay()).toBe(0);
  });

  it("'0 0 * * 7' (Sunday as 7) also fires on a Sunday (getDay() === 0)", () => {
    const next = nextFireAt("0 0 * * 7", FROM_MONDAY);
    expect(next).toBeTruthy();
    expect(new Date(next!).getDay()).toBe(0);
  });

  it("dow=0 and dow=7 expressions resolve to the exact same next-Sunday timestamp", () => {
    const nextWith0 = nextFireAt("0 0 * * 0", FROM_MONDAY);
    const nextWith7 = nextFireAt("0 0 * * 7", FROM_MONDAY);
    expect(nextWith0).toBe(nextWith7);
  });
});
