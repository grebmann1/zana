// Unit tests for packages/work/src/scheduling/triggers/interval.ts
// Covers the start() / stop() lifecycle and the `kind` constant export.
// Complements the broader scheduling/triggers.test.ts which already covers
// happy-path timing and basic validation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

// ── start() ──────────────────────────────────────────────────────────────────

describe("interval.start()", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns a non-null handle for a valid intervalMs", () => {
    const fire = vi.fn();
    const handle = interval.start("s-valid", 1000, fire);
    expect(handle).toBeTruthy();
    interval.stop(handle);
  });

  it("error message includes the scheduleId", () => {
    expect(() => interval.start("my-schedule-id", 0, vi.fn()))
      .toThrow("my-schedule-id");
  });

  it("rejects Infinity as invalid", () => {
    expect(() => interval.start("s-inf", Infinity, vi.fn())).toThrow();
  });

  it("rejects -Infinity as invalid", () => {
    expect(() => interval.start("s-neginf", -Infinity, vi.fn())).toThrow();
  });
});

// ── stop() ───────────────────────────────────────────────────────────────────

describe("interval.stop()", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops the timer so no further fires occur", () => {
    const fire = vi.fn();
    const handle = interval.start("s-stop", 500, fire);
    vi.advanceTimersByTime(1200); // 2 fires
    expect(fire).toHaveBeenCalledTimes(2);
    interval.stop(handle);
    vi.advanceTimersByTime(2000); // no more fires after stop
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("is safe with null", () => {
    expect(() => interval.stop(null as any)).not.toThrow();
  });

  it("is safe with undefined", () => {
    expect(() => interval.stop(undefined as any)).not.toThrow();
  });

  it("is idempotent — a second stop() on the same handle does not throw or re-arm the timer", () => {
    // A scheduler may stop a trigger more than once (e.g. an explicit shutdown
    // racing the failure-breaker that already tore the trigger down). The
    // second stop must be a safe no-op: no throw, and the timer stays stopped.
    const fire = vi.fn();
    const handle = interval.start("s-double-stop", 500, fire);
    vi.advanceTimersByTime(500); // 1 fire
    expect(fire).toHaveBeenCalledTimes(1);

    interval.stop(handle);
    expect(() => interval.stop(handle)).not.toThrow();

    vi.advanceTimersByTime(2000); // still no further fires after the double stop
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

// ── kind constant ─────────────────────────────────────────────────────────────

describe("interval.kind", () => {
  it('equals "interval"', () => {
    expect(interval.kind).toBe("interval");
  });
});
