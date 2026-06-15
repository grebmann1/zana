// Focused timing guard for packages/work/src/scheduling/triggers/interval.ts.
//
// interval.test.ts asserts the fire COUNT after advancing well past several
// boundaries (e.g. 1200ms / 500ms → 2 fires), and interval-fire-error-logging
// covers the throwing path. Neither pins the boundary timing itself: that
// start() arms a setInterval (NOT a synchronous call or a setTimeout-style
// one-shot), so fireFn must NOT run before the first full interval elapses,
// must fire exactly once per interval, and must land on the boundary — not
// one tick early. A regression that swapped setInterval for setTimeout, fired
// eagerly on arm, or used an off-by-one delay would slip past the count-only
// checks but is caught here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

describe("interval.start() — fire cadence and boundary timing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not fire synchronously when the timer is armed", () => {
    const fire = vi.fn();
    const handle = interval.start("s-no-sync", 1000, fire);
    expect(fire).not.toHaveBeenCalled();
    interval.stop(handle);
  });

  it("does not fire one tick before the first interval boundary", () => {
    const fire = vi.fn();
    const handle = interval.start("s-boundary", 1000, fire);

    vi.advanceTimersByTime(999); // just shy of the first boundary
    expect(fire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // now exactly at 1000ms
    expect(fire).toHaveBeenCalledTimes(1);

    interval.stop(handle);
  });

  it("fires exactly once per interval as time advances boundary by boundary", () => {
    const fire = vi.fn();
    const handle = interval.start("s-cadence", 1000, fire);

    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(3);

    interval.stop(handle);
  });
});
