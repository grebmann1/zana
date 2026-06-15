// Edge case for compileField()/nextFireAt() — the bare `n/k` single-value step.
//
// compileField() handles three step forms: "*/k" (the "*" branch), "n-m/k"
// (the range branch), and "n/k" (a single start value with a step — the
// `else` branch where `to = step > 1 ? hi : v`). The existing
// cron-next-fire-compound-fields suite covers the first two but assumed the
// `n/k` form was unreachable because node-cron rejected it.
//
// That assumption is wrong for a start value of 0: node-cron DOES validate
// "0/15 * * * *", so the bare single-value-with-step branch IS reachable
// through the public nextFireAt() API. "0/15" means start at minute 0, step
// by 15, up to the field maximum (59) → fires at :00, :15, :30, :45.
//
// node-cron is NOT mocked — "0/15 * * * *" is validated as valid by the real
// library, so no fake is needed. Minute matching is timezone-independent
// (nextFireAt reads getMinutes()), so these assertions are TZ-robust.

import { describe, it, expect } from "vitest";
import { nextFireAt, validate } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("nextFireAt() — bare n/k single-value step pattern", () => {
  it("'0/15' is accepted by validate() (branch is reachable)", () => {
    expect(validate("0/15 * * * *")).toBe(true);
  });

  it("'0/15 * * * *' fires at the next quarter-hour boundary", () => {
    // 12:07:30 → next whole minute is 12:08; first matching minute is :15.
    const from = new Date("2026-06-15T12:07:30.000Z");
    const next = nextFireAt("0/15 * * * *", from);
    expect(next).toBeTruthy();
    expect(new Date(next!).getMinutes()).toBe(15);
  });

  it("'0/15 * * * *' only ever fires at minutes {0, 15, 30, 45}", () => {
    // Scan two full hours of start instants and collect every fire-minute.
    const base = new Date("2026-06-15T00:00:00.000Z");
    const minutesHit = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const next = nextFireAt("0/15 * * * *", new Date(base.getTime() + i * 60_000));
      if (next) minutesHit.add(new Date(next).getMinutes());
    }
    expect([...minutesHit].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
});
