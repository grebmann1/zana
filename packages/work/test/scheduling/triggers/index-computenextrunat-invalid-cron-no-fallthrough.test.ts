// computeNextRunAt — invalid cron must NOT fall through to a present interval.
//
// computeNextRunAt() mirrors pickBackend()'s cron-before-interval precedence:
// `if (cron) return cronBackend.nextFireAt(cron, from)` returns *whatever* the
// cron backend yields (null for a bad expression) and never continues on to the
// intervalMs branch. The pickBackend side of this invariant is pinned by
// index-invalid-cron-no-interval-fallthrough.test.ts, and index.test.ts pins
// the invalid-cron-with-NO-interval case, but the combination
// "invalid cron alongside a valid intervalMs" in computeNextRunAt is unpinned.
// A refactor that helpfully fell through to the interval backend when the cron
// is bad would silently return `now + intervalMs` here and pass every current
// test. This locks the precedence so that asymmetry stays intentional.
//
// Deterministic: `from` is an injected fixed Date — no real clock.

import { describe, it, expect } from "vitest";
import { computeNextRunAt } from "@zana-ai/work/src/scheduling/triggers/index.ts";

describe("computeNextRunAt — invalid cron does not fall through to interval", () => {
  const from = new Date("2026-06-14T00:00:00.000Z");

  it("returns null when an invalid cron sits alongside a valid intervalMs", () => {
    const next = computeNextRunAt(
      { schedule: { cron: "99 99 99 99 99", intervalMs: 60_000 } },
      from,
    );
    expect(next).toBeNull();
  });

  it("computes the interval next-run once the bad cron is removed (control)", () => {
    const next = computeNextRunAt({ schedule: { intervalMs: 60_000 } }, from);
    expect(next).toBe(new Date(from.getTime() + 60_000).toISOString());
  });
});
