// serializeYaml — nested status block WINS over legacy flat status fields.
//
// Lines 71–81 of yaml-format.ts:
//   1. Merges the nested `status` object into the local `status` accumulator.
//   2. Then conditionally lifts each flat field ONLY when
//      `status.<field> == null` — i.e., the nested value already set
//      that slot, so the flat field is silently dropped.
//
// This ensures that a daemon-managed nested status block (written after a run)
// is never overwritten by a stale legacy flat field that may survive in
// older on-disk files or in-memory schedule representations.
import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("serializeYaml — nested status block wins over flat status fields", () => {
  it("nested lastRunAt is preserved when a flat lastRunAt is also present", () => {
    const sched = {
      id: "conflict-last-run",
      name: "Conflict test",
      schedule: { every: "1h" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "go" },
      // Nested block (daemon-managed, should win):
      status: { lastRunAt: "2026-06-01T12:00:00.000Z" },
      // Legacy flat field (stale, should be ignored):
      lastRunAt: "2025-01-01T00:00:00.000Z",
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.lastRunAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("nested lastRunResult wins over flat lastRunResult", () => {
    const sched = {
      id: "conflict-result",
      name: "Conflict result test",
      schedule: { every: "5m" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      status: { lastRunResult: "ok" },
      lastRunResult: "error",
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.lastRunResult).toBe("ok");
  });

  it("nested nextRunAt wins over flat nextRunAt", () => {
    const sched = {
      id: "conflict-next-run",
      name: "Conflict nextRunAt test",
      schedule: { every: "10m" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      status: { nextRunAt: "2026-06-01T13:00:00.000Z" },
      nextRunAt: "2025-01-01T00:00:00.000Z",
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.nextRunAt).toBe("2026-06-01T13:00:00.000Z");
  });

  it("nested runCount wins over flat runCount", () => {
    const sched = {
      id: "conflict-run-count",
      name: "Conflict runCount test",
      schedule: { every: "2h" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      status: { runCount: 42 },
      runCount: 1,
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.runCount).toBe(42);
  });

  it("all four nested status fields win simultaneously when all flat counterparts are present", () => {
    // Exercises the full block (lines 75–81) in one shot.
    const sched = {
      id: "all-conflict",
      name: "All conflict test",
      schedule: { every: "30m" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      status: {
        lastRunAt: "2026-06-01T12:00:00.000Z",
        lastRunResult: "ok",
        nextRunAt: "2026-06-01T12:30:00.000Z",
        runCount: 99,
      },
      // All four stale flat counterparts — none should survive.
      lastRunAt: "2020-01-01T00:00:00.000Z",
      lastRunResult: "error",
      nextRunAt: "2020-01-01T00:30:00.000Z",
      runCount: 0,
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.lastRunAt).toBe("2026-06-01T12:00:00.000Z");
    expect(parsed.status.lastRunResult).toBe("ok");
    expect(parsed.status.nextRunAt).toBe("2026-06-01T12:30:00.000Z");
    expect(parsed.status.runCount).toBe(99);
    // Flat fields must NOT leak to the document root.
    expect(parsed.lastRunAt).toBeUndefined();
    expect(parsed.lastRunResult).toBeUndefined();
    expect(parsed.nextRunAt).toBeUndefined();
    expect(parsed.runCount).toBeUndefined();
  });

  it("flat fields are still used when the nested status block omits them", () => {
    // Flat field fills a slot the nested block left empty — both paths exercised
    // in the same test: nested wins for lastRunAt, flat fills in runCount.
    const sched = {
      id: "partial-conflict",
      name: "Partial conflict test",
      schedule: { every: "15m" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      // Nested block only covers lastRunAt:
      status: { lastRunAt: "2026-06-01T12:00:00.000Z" },
      // Flat lastRunAt should be ignored (nested wins):
      lastRunAt: "2020-01-01T00:00:00.000Z",
      // Flat runCount should be lifted (nested block doesn't have it):
      runCount: 7,
    };
    const parsed = parseYaml(serializeYaml(sched));
    expect(parsed.status.lastRunAt).toBe("2026-06-01T12:00:00.000Z");
    expect(parsed.status.runCount).toBe(7);
  });
});
