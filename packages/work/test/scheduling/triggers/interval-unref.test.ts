// Unit test for packages/work/src/scheduling/triggers/interval.ts
//
// Pins the documented "don't keep the event loop alive" behavior (interval.ts
// lines 22-23): start() must call unref() on the timer handle it returns, and
// must tolerate a handle that has no unref() method (the `typeof === "function"`
// guard). Neither the unref() call nor that guard branch is exercised by the
// existing interval.test.ts / triggers.test.ts suites.
//
// Deterministic: setInterval is stubbed, so no real timers and no real wall
// clock are involved.

import { describe, it, expect, vi, afterEach } from "vitest";

import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

describe("interval.start() — unref behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls unref() on the timer handle so it won't keep the event loop alive", () => {
    const fakeHandle = { unref: vi.fn() };
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeHandle as any);

    const returned = interval.start("s-unref", 1000, vi.fn());

    // start() must wire through the exact handle setInterval produced...
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(returned).toBe(fakeHandle);
    // ...and unref it so the schedule timer is non-blocking.
    expect(fakeHandle.unref).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the timer handle has no unref() method", () => {
    // Some runtimes return a numeric/handle without unref — the typeof guard
    // must keep start() from blowing up.
    const handleWithoutUnref = {};
    vi.spyOn(globalThis, "setInterval").mockReturnValue(handleWithoutUnref as any);

    expect(() => interval.start("s-no-unref", 1000, vi.fn())).not.toThrow();
  });
});
