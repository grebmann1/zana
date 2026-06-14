// Unit test for packages/work/src/scheduling/triggers/interval.ts
//
// Pins the OBSERVABILITY half of the fire-fn catch block (interval.ts ~lines
// 16-22): when the caller's fireFn throws, start() must not only keep the
// timer alive (already covered by triggers.test.ts "isolates fire-fn errors")
// but also SURFACE the failure to the "scheduler" logger, tagged with the
// scheduleId and carrying the original error. No existing test asserts that
// the swallowed error is actually logged — without this, a regression that
// silently drops the log (turning a noisy failure into an invisible one)
// would go unnoticed.
//
// interval.ts reaches the logger lazily via
//   require("@zana-ai/core").util.logger.getLogger("scheduler")
// which resolves to the built core instance — so we spy on THAT module's
// getLogger rather than vi.mock()-ing the bare specifier (vi.mock does not
// intercept the CJS require to the dist build).
//
// Deterministic: fake timers drive the tick and the logger is stubbed, so
// there is no real wall clock, no stderr write, and no network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as coreNs from "@zana-ai/core";
import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

// CJS interop: the package is `module.exports = {...}`, so the live object may
// arrive on `.default` depending on the loader.
const core: any = (coreNs as any).default ?? coreNs;

describe("interval.start() — logs fire-fn errors via the scheduler logger", () => {
  let errorSpy: ReturnType<typeof vi.fn>;
  let getLoggerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errorSpy = vi.fn();
    getLoggerSpy = vi
      .spyOn(core.util.logger, "getLogger")
      .mockReturnValue({
        error: errorSpy,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("routes a throwing fireFn to logger.error tagged with the scheduleId and the original error", () => {
    const boom = new Error("kaboom");
    const fire = vi.fn(() => {
      throw boom;
    });

    const handle = interval.start("sched-log-1", 1000, fire);

    // The throw on the first tick must not propagate out of the timer...
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(fire).toHaveBeenCalledTimes(1);

    // ...and must be logged exactly once, on the "scheduler" logger, with the
    // scheduleId in the message and the original Error forwarded verbatim.
    expect(getLoggerSpy).toHaveBeenCalledWith("scheduler");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = errorSpy.mock.calls[0];
    expect(String(msg)).toContain("sched-log-1");
    expect(err).toBe(boom);

    interval.stop(handle);
  });

  it("logs once per failing tick (a throwing fireFn keeps firing and keeps logging)", () => {
    const fire = vi.fn(() => {
      throw new Error("repeat");
    });

    const handle = interval.start("sched-log-2", 1000, fire);
    vi.advanceTimersByTime(3000); // three ticks → three throws → three logs

    expect(fire).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(3);

    interval.stop(handle);
  });
});
