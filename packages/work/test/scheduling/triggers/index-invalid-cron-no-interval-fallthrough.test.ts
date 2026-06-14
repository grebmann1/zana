// pickBackend — invalid cron must NOT fall through to a present interval.
//
// pickBackend() enters the cron branch whenever a (truthy) cron expression is
// present, and returns null if cronBackend.validate() rejects it. Crucially it
// does NOT continue on to consider intervalMs. The existing null-cases test
// only exercises an invalid cron with no interval, so a future refactor that
// "helpfully" fell through to the interval backend when the cron is bad would
// pass every current test. This pins that precedence invariant.

import { describe, it, expect } from "vitest";
import { pickBackend } from "@zana-ai/work/src/scheduling/triggers/index.ts";

describe("pickBackend — invalid cron does not fall through to interval", () => {
  it("returns null when an invalid cron sits alongside a valid intervalMs", () => {
    const picked = pickBackend({
      schedule: { cron: "99 99 99 99 99", intervalMs: 60_000 },
    });
    expect(picked).toBeNull();
  });

  it("picks the interval backend once the bad cron is removed (control)", () => {
    const picked = pickBackend({ schedule: { intervalMs: 60_000 } });
    expect(picked).not.toBeNull();
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(60_000);
  });
});
