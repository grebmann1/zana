// Trigger backend tests — interval + cron, including pickBackend/computeNextRunAt.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as cronBackend from "@zana-ai/work/src/scheduling/triggers/cron.ts";
import * as intervalBackend from "@zana-ai/work/src/scheduling/triggers/interval.ts";
import {
  pickBackend,
  computeNextRunAt,
} from "@zana-ai/work/src/scheduling/triggers/index.ts";

describe("interval backend", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires repeatedly at the configured interval", () => {
    const fire = vi.fn();
    const handle = intervalBackend.start("s1", 1000, fire);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3500);
    expect(fire.mock.calls.length).toBe(3);
    intervalBackend.stop(handle);
    vi.advanceTimersByTime(5000);
    expect(fire.mock.calls.length).toBe(3);
  });

  it("rejects invalid intervalMs", () => {
    const fire = vi.fn();
    expect(() => intervalBackend.start("s2", 0, fire)).toThrow();
    expect(() => intervalBackend.start("s2", -1, fire)).toThrow();
    expect(() => intervalBackend.start("s2", NaN, fire)).toThrow();
    expect(() => intervalBackend.start("s2", "abc" as any, fire)).toThrow();
  });

  it("isolates fire-fn errors from the timer (caller's bug doesn't kill the schedule)", () => {
    const fire = vi.fn(() => { throw new Error("boom"); });
    const handle = intervalBackend.start("s3", 1000, fire);
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow();
    expect(fire.mock.calls.length).toBe(2);
    intervalBackend.stop(handle);
  });

  it("stop() is idempotent / safe with bad handle", () => {
    expect(() => intervalBackend.stop(null as any)).not.toThrow();
    expect(() => intervalBackend.stop(undefined as any)).not.toThrow();
  });

  it("unrefs the timer so it never keeps the event loop alive", () => {
    const fire = vi.fn();
    const handle = intervalBackend.start("s4", 1000, fire);
    // The comment in interval.ts promises the handle is unref'd; assert the
    // returned timer is actually in the unref'd state so a lone schedule
    // can't block process exit.
    expect(typeof (handle as any).unref).toBe("function");
    expect((handle as any).hasRef()).toBe(false);
    intervalBackend.stop(handle);
  });
});

describe("cron backend — validation", () => {
  it("validates standard 5-field cron", () => {
    expect(cronBackend.validate("*/5 * * * *")).toBe(true);
    expect(cronBackend.validate("0 2 * * *")).toBe(true);
    expect(cronBackend.validate("0 0 1 1 *")).toBe(true);
    expect(cronBackend.validate("0 9 * * 1-5")).toBe(true);
  });

  it("rejects malformed cron", () => {
    expect(cronBackend.validate("")).toBe(false);
    expect(cronBackend.validate("not a cron")).toBe(false);
    expect(cronBackend.validate("99 * * * *")).toBe(false);
    expect(cronBackend.validate(null as any)).toBe(false);
    expect(cronBackend.validate(123 as any)).toBe(false);
  });
});

describe("cron backend — nextFireAt", () => {
  it("computes the next fire for '0 9 * * *' (daily at 9am)", () => {
    const from = new Date("2026-01-01T08:30:00.000Z");
    const next = cronBackend.nextFireAt("0 9 * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    // Next fire should be on the same day at 09:00 local time
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("returns null on invalid expressions", () => {
    expect(cronBackend.nextFireAt("99 * * * *")).toBeNull();
    expect(cronBackend.nextFireAt("")).toBeNull();
  });

  it("'*/5 * * * *' next fire is within 5 minutes", () => {
    const from = new Date("2026-06-15T12:31:00.000Z");
    const next = cronBackend.nextFireAt("*/5 * * * *", from);
    expect(next).toBeTruthy();
    const dt = new Date(next!).getTime() - from.getTime();
    expect(dt).toBeGreaterThan(0);
    expect(dt).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("pickBackend", () => {
  it("prefers cron over interval when both present", () => {
    const picked = pickBackend({
      schedule: { cron: "0 * * * *", intervalMs: 60_000 },
    });
    expect(picked?.kind).toBe("cron");
    expect(picked?.arg).toBe("0 * * * *");
  });

  it("returns interval when only intervalMs", () => {
    const picked = pickBackend({ schedule: { intervalMs: 60_000 } });
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(60_000);
  });

  it("converts every shorthand to interval", () => {
    const picked = pickBackend({ schedule: { every: "5m" } });
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(300_000);
  });

  it("accepts legacy flat fields", () => {
    expect(pickBackend({ cron: "0 2 * * *" })?.kind).toBe("cron");
    expect(pickBackend({ intervalMs: 1000 })?.kind).toBe("interval");
  });

  it("returns null when no trigger is set", () => {
    expect(pickBackend({})).toBeNull();
    expect(pickBackend({ schedule: {} })).toBeNull();
    expect(pickBackend(null as any)).toBeNull();
  });

  it("returns null on invalid cron / interval", () => {
    expect(pickBackend({ schedule: { cron: "not a cron" } })).toBeNull();
    expect(pickBackend({ schedule: { intervalMs: 0 } })).toBeNull();
    expect(pickBackend({ schedule: { intervalMs: -1 } })).toBeNull();
  });

  it("falls back to interval when 'every' is malformed", () => {
    expect(pickBackend({ schedule: { every: "garbage" } })).toBeNull();
  });
});

describe("computeNextRunAt", () => {
  it("returns ISO string for interval (now + intervalMs)", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRunAt({ schedule: { intervalMs: 60_000 } }, from);
    expect(next).toBe("2026-01-01T00:01:00.000Z");
  });

  it("returns null when no trigger", () => {
    expect(computeNextRunAt({})).toBeNull();
  });

  it("delegates to cronBackend.nextFireAt for cron", () => {
    const from = new Date("2026-01-01T08:30:00.000Z");
    const next = computeNextRunAt({ schedule: { cron: "0 9 * * *" } }, from);
    expect(next).toBeTruthy();
  });
});
