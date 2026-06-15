// Precedence: an explicit `intervalMs` wins over a present `every` shorthand.
//
// readScheduleBlock() only consults the `every` shorthand when no explicit
// intervalMs was supplied:
//
//     let intervalMs = block.intervalMs ?? schedule?.intervalMs ?? null;
//     ...
//     if (intervalMs == null && typeof every === "string") {
//       intervalMs = everShorthandToMs(every);
//     }
//
// So when a schedule carries BOTH a numeric intervalMs and an `every` string,
// the `every` value must be ignored entirely. Existing `every` tests always
// supply `every` alone; none pin this guard. A regression that dropped the
// `intervalMs == null` check (or flipped the precedence) would silently let a
// stray `every` field override an explicit interval — this test catches that.
//
// The two values are deliberately distinct (30s vs 1h) so the assertions can
// tell which one actually won. No mocks, no real timers — pure input/output.
import { describe, it, expect } from "vitest";
import { pickBackend, computeNextRunAt } from "@zana-ai/work/src/scheduling/triggers/index.ts";

const EXPLICIT_MS = 30_000; // 30s
const EVERY_MS = 3_600_000; // "1h" — must NOT win

describe("readScheduleBlock precedence — explicit intervalMs wins over `every`", () => {
  it("pickBackend uses the explicit intervalMs, not the every shorthand", () => {
    const picked = pickBackend({ schedule: { intervalMs: EXPLICIT_MS, every: "1h" } });
    expect(picked).not.toBeNull();
    expect(picked!.kind).toBe("interval");
    expect(picked!.arg).toBe(EXPLICIT_MS);
    expect(picked!.arg).not.toBe(EVERY_MS);
  });

  it("computeNextRunAt advances by the explicit intervalMs, ignoring `every`", () => {
    const from = new Date("2026-06-14T00:00:00.000Z");
    const next = computeNextRunAt({ schedule: { intervalMs: EXPLICIT_MS, every: "1h" } }, from);
    expect(next).toBe(new Date(from.getTime() + EXPLICIT_MS).toISOString());
  });

  it("flat (unwrapped) intervalMs also takes precedence over a flat `every`", () => {
    const from = new Date("2026-06-14T00:00:00.000Z");
    const next = computeNextRunAt({ intervalMs: EXPLICIT_MS, every: "1h" }, from);
    expect(next).toBe(new Date(from.getTime() + EXPLICIT_MS).toISOString());
  });
});
