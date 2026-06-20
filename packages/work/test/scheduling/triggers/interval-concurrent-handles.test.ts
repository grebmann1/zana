// Unit tests for handle isolation across concurrent interval triggers in
// packages/work/src/scheduling/triggers/interval.ts.
//
// The scheduler arms many interval triggers at once (one per schedule). The
// existing interval tests only ever exercise a single handle, so they never
// prove that the per-schedule handles are independent: each must fire on its
// OWN cadence, and stopping one must NOT disarm the others. Without this an
// off-by-one in handle bookkeeping (e.g. sharing a single module-level timer)
// would go unnoticed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

describe("interval.start() — concurrent handle isolation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires two concurrent schedules on their own cadences", () => {
    const fast = vi.fn();
    const slow = vi.fn();
    const hFast = interval.start("s-fast", 100, fast);
    const hSlow = interval.start("s-slow", 250, slow);

    // 500ms → fast fires every 100ms (5), slow every 250ms (2).
    vi.advanceTimersByTime(500);
    expect(fast).toHaveBeenCalledTimes(5);
    expect(slow).toHaveBeenCalledTimes(2);

    interval.stop(hFast);
    interval.stop(hSlow);
  });

  it("stopping one schedule leaves the other still firing", () => {
    const stopped = vi.fn();
    const survivor = vi.fn();
    const hStopped = interval.start("s-stopped", 100, stopped);
    const hSurvivor = interval.start("s-survivor", 100, survivor);

    vi.advanceTimersByTime(100); // both fire once
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);

    interval.stop(hStopped);

    vi.advanceTimersByTime(300); // only the survivor should keep firing
    expect(stopped).toHaveBeenCalledTimes(1); // unchanged after its stop
    expect(survivor).toHaveBeenCalledTimes(4); // 1 + 3 more

    interval.stop(hSurvivor);
  });
});
