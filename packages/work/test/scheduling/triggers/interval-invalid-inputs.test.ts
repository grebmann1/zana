// Unit tests for the intervalMs validation guard in interval.start().
// Complements interval.test.ts, which already covers 0 / Infinity / -Infinity.
// These cover the remaining invalid-input branches: NaN, finite negatives,
// and non-number types — all of which must throw and never arm a timer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as interval from "@zana-ai/work/src/scheduling/triggers/interval.ts";

describe("interval.start() — intervalMs validation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rejects NaN as invalid", () => {
    expect(() => interval.start("s-nan", NaN, vi.fn())).toThrow();
  });

  it("rejects a finite negative interval as invalid", () => {
    expect(() => interval.start("s-neg", -100, vi.fn())).toThrow();
  });

  it("rejects a non-number intervalMs as invalid", () => {
    expect(() => interval.start("s-str", "1000" as any, vi.fn())).toThrow();
  });

  it("does not arm a timer when validation fails (fireFn never called)", () => {
    const fire = vi.fn();
    expect(() => interval.start("s-noarm", NaN, fire)).toThrow();
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
  });
});
