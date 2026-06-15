// Unit test for the WRAPPED CALLBACK inside cron.start() (cron.ts ~lines 28-36).
//
// The existing cron.test.ts only asserts that start() returns a handle and does
// not throw — it never captures the callback handed to nodeCron.schedule(), so
// the two behaviors that callback actually owns are unexecuted by any test:
//
//   1. Happy path: when node-cron fires, the wrapper calls the caller's fireFn.
//   2. Error path: when fireFn throws, the wrapper SWALLOWS the error and
//      routes it to the "scheduler" logger tagged with the scheduleId — the
//      throw must NOT propagate out of the cron tick.
//
// cron.ts captures node-cron once at module load via `require("node-cron")` and
// later calls `nodeCron.schedule(...)` as a property lookup at fire-setup time.
// We therefore spy on the REAL node-cron's `schedule` method (same cached object
// the source holds) to capture the wrapper callback and invoke it directly — no
// real cron job, no wall clock. `validate` stays real, so valid expressions pass.
// The logger is reached lazily via require("@zana-ai/core").util.logger; we spy
// on that live core module, matching interval-fire-error-logging.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as nodeCronNs from "node-cron";
import * as coreNs from "@zana-ai/core";
import * as cron from "@zana-ai/work/src/scheduling/triggers/cron.ts";

// CJS interop: both packages ship as module.exports, may surface on .default.
const nodeCron: any = (nodeCronNs as any).default ?? nodeCronNs;
const core: any = (coreNs as any).default ?? coreNs;

describe("cron.start() — wrapped callback invocation", () => {
  let scheduleSpy: ReturnType<typeof vi.spyOn>;
  let captured: (() => void) | undefined;

  beforeEach(() => {
    captured = undefined;
    scheduleSpy = vi
      .spyOn(nodeCron, "schedule")
      .mockImplementation(((_expr: string, cb: () => void) => {
        captured = cb;
        return { stop: vi.fn(), start: vi.fn() };
      }) as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the caller's fireFn only when the scheduled cron callback runs", () => {
    const fire = vi.fn();
    cron.start("sched-ok", "* * * * *", fire);

    // The wrapper is registered with node-cron but must not fire eagerly.
    expect(scheduleSpy).toHaveBeenCalledOnce();
    expect(typeof captured).toBe("function");
    expect(fire).not.toHaveBeenCalled();

    // Simulate node-cron firing the tick.
    captured!();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing fireFn and logs it to the scheduler logger with the scheduleId", () => {
    const errorSpy = vi.fn();
    const getLoggerSpy = vi
      .spyOn(core.util.logger, "getLogger")
      .mockReturnValue({
        error: errorSpy,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any);

    const boom = new Error("kaboom");
    const fire = vi.fn(() => {
      throw boom;
    });
    cron.start("sched-boom", "*/5 * * * *", fire);

    // The throw inside the tick must be caught by the wrapper, not propagated.
    expect(typeof captured).toBe("function");
    expect(() => captured!()).not.toThrow();
    expect(fire).toHaveBeenCalledTimes(1);

    // ...and surfaced exactly once on the "scheduler" logger, carrying the
    // scheduleId in the message and the original Error verbatim.
    expect(getLoggerSpy).toHaveBeenCalledWith("scheduler");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = errorSpy.mock.calls[0];
    expect(String(msg)).toContain("sched-boom");
    expect(err).toBe(boom);
  });
});
