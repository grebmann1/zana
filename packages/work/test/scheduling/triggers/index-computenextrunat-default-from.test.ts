// computeNextRunAt() default `from` parameter — the implicit clock path.
//
//     export function computeNextRunAt(schedule, from = new Date()): ...
//
// Every existing computeNextRunAt test passes an explicit `from` Date (the
// only single-arg calls hit a null-return path before `from` is ever read).
// So the `from = new Date()` default — what production actually uses, since
// callers rarely supply a clock — is unpinned. A refactor that dropped the
// default (or mis-wired it) would break real scheduling while every current
// test stayed green. This pins it by freezing the system clock with fake
// timers and asserting the implicit `from` is "now".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeNextRunAt } from "@zana-ai/work/src/scheduling/triggers/index.ts";

const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("computeNextRunAt — default `from` uses the current clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("interval branch advances from now when `from` is omitted", () => {
    // No `from` arg → default `new Date()` → NOW + 15m. Interval math is in
    // absolute ms (from.getTime() + intervalMs), so it is timezone-independent.
    const next = computeNextRunAt({ schedule: { intervalMs: 15 * 60_000 } });
    expect(next).toBe("2026-06-15T12:15:00.000Z");
  });

  it("flat `every` shorthand also advances from the implicit now", () => {
    // Exercises the default `from` through the every→intervalMs conversion path.
    const next = computeNextRunAt({ every: "30m" });
    expect(next).toBe("2026-06-15T12:30:00.000Z");
  });
});
