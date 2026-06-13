// Field-precedence invariants for scheduling/triggers/index.ts.
//
// readScheduleBlock() resolves trigger fields from TWO places — a nested
// `schedule.schedule` block and the legacy flat fields on the schedule
// itself — and the nested block must win:
//   cron:       block.cron || schedule.cron
//   intervalMs: block.intervalMs ?? schedule.intervalMs
//
// Separately, computeNextRunAt() has its OWN cron-before-interval branch
// (independent of pickBackend's, which is already pinned in triggers.test.ts).
// When a schedule carries both a cron and an intervalMs, computeNextRunAt must
// follow the cron branch. These cases were previously unguarded.
import { describe, it, expect } from "vitest";
import {
  pickBackend,
  computeNextRunAt,
} from "@zana-ai/work/src/scheduling/triggers/index.ts";

describe("readScheduleBlock — nested block overrides legacy flat fields", () => {
  it("nested schedule.intervalMs wins over flat intervalMs in pickBackend", () => {
    const picked = pickBackend({
      schedule: { intervalMs: 5_000 },
      intervalMs: 99_000, // legacy flat field — must be ignored
    });
    expect(picked?.kind).toBe("interval");
    expect(picked?.arg).toBe(5_000);
  });

  it("nested schedule.cron wins over flat cron in pickBackend", () => {
    const picked = pickBackend({
      schedule: { cron: "0 9 * * *" },
      cron: "0 0 * * *", // legacy flat field — must be ignored
    });
    expect(picked?.kind).toBe("cron");
    expect(picked?.arg).toBe("0 9 * * *");
  });

  it("nested schedule.intervalMs wins over flat field in computeNextRunAt", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRunAt(
      { schedule: { intervalMs: 30_000 }, intervalMs: 99_000 },
      from,
    );
    // 30s from `from`, not 99s — proves the nested value was used.
    expect(next).toBe("2026-01-01T00:00:30.000Z");
  });
});

describe("computeNextRunAt — cron precedence when both cron and interval present", () => {
  it("follows the cron branch (not interval) when both fields are set", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const both = computeNextRunAt(
      { schedule: { cron: "0 1 * * *", intervalMs: 60_000 } },
      from,
    );
    // Exact cron fire time depends on the host timezone, so assert by
    // equivalence rather than a hardcoded instant:
    //   - it must equal the cron-only result (cron branch was taken), and
    //   - it must NOT equal the interval-only result (00:01:00).
    const cronOnly = computeNextRunAt({ schedule: { cron: "0 1 * * *" } }, from);
    expect(both).toBe(cronOnly);
    expect(both).not.toBe("2026-01-01T00:01:00.000Z");
  });
});
