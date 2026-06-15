// Edge case for compileField()/nextFireAt() — the POSITIVE day-of-month branch.
//
// The existing cron suite exercises minute, hour, weekday and step fields, plus
// the NEGATIVE day-of-month case ("0 0 31 2 *" → Feb 31 never fires → null).
// What no test pins is the POSITIVE side: that a specific day-of-month value
// (domMatch) actually gates the fire to the right calendar day within the
// 7-day search horizon. A regression that ignored the dom field (e.g. treated
// it as "*") would still satisfy every other cron test but would break here.
//
// node-cron is NOT mocked — "30 14 17 * *" is a valid standard 5-field
// expression accepted by the real library.
//
// Timezone-robust: the minute scan in nextFireAt() reads LOCAL date/time
// components (getDate/getHours/getMinutes), so we assert on the same LOCAL
// getters of the returned Date rather than on the UTC ISO string. Deterministic:
// `from` is a fixed instant, no real clock is consulted.

import { describe, it, expect } from "vitest";
import { nextFireAt } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("nextFireAt() — positive day-of-month gating", () => {
  it("'30 14 17 * *' fires on day 17 at 14:30, not on an earlier day", () => {
    // From mid-June; the 17th is a couple of days out — well inside the
    // 7-day horizon, so a match must be found and it must land on the 17th.
    const from = new Date("2026-06-15T08:00:00.000Z");
    const next = nextFireAt("30 14 17 * *", from);

    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it("does not fire on any day other than the configured day-of-month", () => {
    // Scan a full week of start points; every resolved fire must be on day 17.
    const base = new Date("2026-06-13T00:00:00.000Z");
    const daysHit = new Set<number>();
    for (let i = 0; i < 7; i++) {
      const from = new Date(base.getTime() + i * 86_400_000);
      const next = nextFireAt("30 14 17 * *", from);
      if (next) daysHit.add(new Date(next).getDate());
    }
    expect([...daysHit]).toEqual([17]);
  });
});
