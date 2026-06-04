// Tests for scheduling/triggers/index.ts — pickBackend and computeNextRunAt
// edge cases not covered by the flat triggers.test.ts file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  pickBackend,
  computeNextRunAt,
} from "@zana-ai/work/src/scheduling/triggers/index.ts";
import * as intervalBackend from "@zana-ai/work/src/scheduling/triggers/interval.ts";
import * as cronBackend from "@zana-ai/work/src/scheduling/triggers/cron.ts";

// ---------------------------------------------------------------------------
// pickBackend — returned object wiring
// ---------------------------------------------------------------------------
describe("pickBackend — returned backend wiring", () => {
  it("interval backend: start/stop are the real intervalBackend functions", () => {
    const picked = pickBackend({ schedule: { intervalMs: 5_000 } });
    expect(picked).not.toBeNull();
    expect(picked!.start).toBe(intervalBackend.start);
    expect(picked!.stop).toBe(intervalBackend.stop);
  });

  it("cron backend: start/stop are the real cronBackend functions", () => {
    const picked = pickBackend({ schedule: { cron: "*/5 * * * *" } });
    expect(picked).not.toBeNull();
    expect(picked!.start).toBe(cronBackend.start);
    expect(picked!.stop).toBe(cronBackend.stop);
  });

  it("every shorthand: arg equals the converted milliseconds", () => {
    // "2m" → 120_000 ms
    const picked = pickBackend({ schedule: { every: "2m" } });
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(120_000);
    expect(picked!.start).toBe(intervalBackend.start);
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt — legacy flat-field paths
// ---------------------------------------------------------------------------
describe("computeNextRunAt — legacy flat fields", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");

  it("handles flat intervalMs (no schedule wrapper)", () => {
    const next = computeNextRunAt({ intervalMs: 30_000 }, from);
    expect(next).toBe("2026-01-01T00:00:30.000Z");
  });

  it("handles flat cron field (no schedule wrapper)", () => {
    const next = computeNextRunAt({ cron: "0 9 * * *" }, from);
    expect(next).toBeTruthy();
    expect(typeof next).toBe("string");
    // Should be a valid ISO date in the future relative to `from`
    expect(new Date(next!).getTime()).toBeGreaterThan(from.getTime());
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt — every shorthand path
// ---------------------------------------------------------------------------
describe("computeNextRunAt — every shorthand", () => {
  it("converts 'every: 10m' to interval-based next-run-at", () => {
    const from = new Date("2026-03-15T12:00:00.000Z");
    const next = computeNextRunAt({ schedule: { every: "10m" } }, from);
    expect(next).toBe("2026-03-15T12:10:00.000Z");
  });

  it("converts 'every: 1h' correctly", () => {
    const from = new Date("2026-03-15T08:00:00.000Z");
    const next = computeNextRunAt({ schedule: { every: "1h" } }, from);
    expect(next).toBe("2026-03-15T09:00:00.000Z");
  });

  it("malformed every shorthand returns null", () => {
    expect(computeNextRunAt({ schedule: { every: "garbage" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt — null / undefined inputs
// ---------------------------------------------------------------------------
describe("computeNextRunAt — null/undefined inputs", () => {
  it("returns null for null input", () => {
    expect(computeNextRunAt(null as any)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(computeNextRunAt(undefined as any)).toBeNull();
  });
});
