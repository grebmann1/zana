// Unit tests for packages/work/src/scheduling/triggers/cron.ts
// Covers start() / stop() lifecycle and nextFireAt() edge-cases that are
// absent from the combined triggers.test.ts.
// node-cron is mocked so no real scheduled jobs run.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock node-cron before importing the module under test ─────────────────
// The mock validate accepts 5- or 6-field standard cron expressions, matching
// real node-cron semantics closely enough for unit tests.
const mockTask = { stop: vi.fn(), start: vi.fn() };
const mockValidate = (expr: string) =>
  typeof expr === "string" && /^(\S+ ){4,5}\S+$/.test(expr.trim());
vi.mock("node-cron", () => ({
  default: {
    validate: mockValidate,
    schedule: vi.fn(() => mockTask),
  },
  validate: mockValidate,
  schedule: vi.fn(() => mockTask),
}));

import * as cron from "@zana-ai/work/src/scheduling/triggers/cron.ts";

// ─────────────────────────────────────────────────────────────────────────
// start()
// ─────────────────────────────────────────────────────────────────────────

describe("cron.start()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTask.stop.mockReset();
  });

  it("throws on an invalid cron expression", () => {
    expect(() => cron.start("s1", "not-a-cron", vi.fn())).toThrow(/invalid expression/);
  });

  it("throws on an empty expression", () => {
    expect(() => cron.start("s1", "", vi.fn())).toThrow();
  });

  it("returns a handle with a stop method for a valid expression", () => {
    const fire = vi.fn();
    const handle = cron.start("s1", "*/5 * * * *", fire);
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
  });

  it("isolates fireFn errors — a throwing callback does not propagate", () => {
    // The wrapped callback should catch errors internally.
    // We verify start() itself does not throw even when fireFn throws.
    const fire = vi.fn(() => { throw new Error("callback exploded"); });
    expect(() => cron.start("s2", "0 * * * *", fire)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// stop()
// ─────────────────────────────────────────────────────────────────────────

describe("cron.stop()", () => {
  it("calls handle.stop() when given a valid handle", () => {
    const handle = { stop: vi.fn() };
    cron.stop(handle);
    expect(handle.stop).toHaveBeenCalledOnce();
  });

  it("is safe with null", () => {
    expect(() => cron.stop(null)).not.toThrow();
  });

  it("is safe with undefined", () => {
    expect(() => cron.stop(undefined)).not.toThrow();
  });

  it("is safe when handle.stop throws", () => {
    const handle = { stop: vi.fn(() => { throw new Error("oops"); }) };
    expect(() => cron.stop(handle)).not.toThrow();
  });

  it("is safe with a handle that has no stop method", () => {
    expect(() => cron.stop({} as any)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// nextFireAt() — edge cases not in triggers.test.ts
// ─────────────────────────────────────────────────────────────────────────

describe("cron.nextFireAt() — complex field patterns", () => {
  it("comma-list minute field: '1,30 * * * *' fires at :01 or :30", () => {
    // Start just before minute 1 so the very next minute qualifies.
    const from = new Date("2026-06-15T12:00:30.000Z");
    const next = cron.nextFireAt("1,30 * * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect([1, 30]).toContain(d.getMinutes());
  });

  it("range expression '0-5 * * * *' fires within the 0–5 minute window", () => {
    const from = new Date("2026-06-15T12:59:00.000Z");
    const next = cron.nextFireAt("0-5 * * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect(d.getMinutes()).toBeGreaterThanOrEqual(0);
    expect(d.getMinutes()).toBeLessThanOrEqual(5);
  });

  it("step range '*/15 * * * *' fires on a 15-minute boundary", () => {
    const from = new Date("2026-06-15T12:00:30.000Z");
    const next = cron.nextFireAt("*/15 * * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect(d.getMinutes() % 15).toBe(0);
  });

  it("explicit hour range '9-17 * * * *' fires during 09:00–17:59", () => {
    // From 08:30 — first match should be within hour 9.
    const from = new Date("2026-06-15T08:30:00.000Z");
    const next = cron.nextFireAt("0 9-17 * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect(d.getHours()).toBeGreaterThanOrEqual(9);
    expect(d.getHours()).toBeLessThanOrEqual(17);
  });

  it("6-field expression is handled — seconds field is stripped, result is non-null", () => {
    // The implementation supports 6 fields by slicing off the leading seconds
    // field: "0 */5 * * * *" → treat as "*/5 * * * *" (every 5 minutes).
    const from = new Date("2026-06-15T12:00:00.000Z");
    const next = cron.nextFireAt("0 */5 * * * *", from);
    expect(next).toBeTruthy();
    const d = new Date(next!);
    expect(d.getMinutes() % 5).toBe(0);
  });

  it("returns null for a 7-field expression (out of range)", () => {
    // More than 6 fields → rejected by the field-length guard.
    const from = new Date("2026-06-15T12:00:00.000Z");
    const next = cron.nextFireAt("0 0 */5 * * * *", from);
    expect(next).toBeNull();
  });

  it("returns null for an expression that never fires within 7 days (Feb 31)", () => {
    // Feb 31 never exists — scan will exhaust the 7-day window and return null.
    const from = new Date("2026-02-01T00:00:00.000Z");
    const next = cron.nextFireAt("0 0 31 2 *", from);
    expect(next).toBeNull();
  });

  it("next fire is strictly in the future (not at `from` itself)", () => {
    // Even if `from` falls exactly on a fire time, the result must be later.
    const from = new Date("2026-06-15T12:00:00.000Z"); // exactly on :00
    const next = cron.nextFireAt("* * * * *", from);
    expect(next).toBeTruthy();
    expect(new Date(next!).getTime()).toBeGreaterThan(from.getTime());
  });
});
