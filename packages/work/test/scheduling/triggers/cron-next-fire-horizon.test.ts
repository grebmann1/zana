// Tests for the 7-day search horizon of nextFireAt() in cron.ts.
//
// nextFireAt() scans minute-by-minute over a fixed 7-day window (see the
// `horizon` constant in the source). Two consequences of that window are
// NOT exercised by any existing cron test:
//
//   1. A perfectly VALID cron expression whose next fire lands beyond 7 days
//      (e.g. a monthly "0 0 1 * *" evaluated mid-month) returns null — even
//      though node-cron validates the expression. The existing "Feb 31" test
//      only covers a date that never exists; this covers a date that simply
//      falls outside the search window.
//   2. A frequent expression evaluated from the same instant DOES resolve,
//      and the result stays inside the 7-day window — proving the null above
//      is a horizon limitation, not a blanket failure.
//
// node-cron is NOT mocked — all expressions here are real, valid 5-field
// crons. All assertions are timezone-independent: they compare against `null`
// and against millisecond deltas from `from`, never against wall-clock
// hour/day fields (which nextFireAt derives in local time).

import { describe, it, expect } from "vitest";
import { nextFireAt } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

const SEVEN_DAYS_MS = 7 * 86_400_000;

describe("nextFireAt() — 7-day search horizon", () => {
  // Mid-month start: the next "1st of the month at midnight" is ~18 days out,
  // comfortably beyond the 7-day window regardless of the host timezone
  // (a ±14h TZ shift cannot pull July 1 inside 7 days of June 13).
  const FROM = new Date("2026-06-13T00:00:00.000Z");

  it("returns null for a valid monthly expression whose next fire is beyond 7 days", () => {
    const next = nextFireAt("0 0 1 * *", FROM);
    expect(next).toBeNull();
  });

  it("still resolves a frequent expression from the same instant (not a blanket failure)", () => {
    const next = nextFireAt("*/30 * * * *", FROM);
    expect(next).toBeTruthy();
  });

  it("keeps a resolved fire time strictly inside the 7-day window", () => {
    const next = nextFireAt("0 0 * * *", FROM); // daily midnight — within 1 day
    expect(next).toBeTruthy();
    const delta = new Date(next!).getTime() - FROM.getTime();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(SEVEN_DAYS_MS);
  });
});
