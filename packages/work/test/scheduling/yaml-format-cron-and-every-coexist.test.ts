// serializeYaml — nested cron + every coexistence.
//
// Lines 46-48 of yaml-format.ts copy `cron`, `every`, and `intervalMs` from the
// nested schedule block with three INDEPENDENT `if` statements — there is no
// mutual exclusion between them. Existing coverage only exercises pairs that the
// backend treats as compatible (cron + intervalMs in flat-vs-nested-precedence,
// every + intervalMs in the base round-trip). None asserts that a block carrying
// BOTH a `cron` expression and an `every` shorthand is preserved verbatim.
//
// This matters because the two fields select different trigger backends
// (pickBackend reads cron first, then every/intervalMs). serializeYaml must not
// editorialize — it round-trips whatever the caller wrote so the daemon, not the
// serializer, decides precedence. A future refactor that collapses lines 46-47
// into an `else if` (dropping `every` whenever `cron` is present) would pass
// every current test but silently lose data on disk; this test locks it.
import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("serializeYaml — nested cron and every coexist", () => {
  it("preserves both cron and every verbatim when both are present", () => {
    const sched = {
      id: "cron-and-every",
      name: "Both timing fields",
      enabled: true,
      schedule: { cron: "0 2 * * *", every: "5m" },
      action: { type: "spawn-agent", profileId: "worker", prompt: "go" },
    };

    const parsed = parseYaml(serializeYaml(sched));

    expect(parsed.schedule).toBeDefined();
    expect(parsed.schedule.cron).toBe("0 2 * * *");
    expect(parsed.schedule.every).toBe("5m");
    // Neither field should be lifted/duplicated to the document root.
    expect(parsed.cron).toBeUndefined();
    expect(parsed.every).toBeUndefined();
  });

  it("keeps every alongside cron even when an explicit intervalMs is also set", () => {
    const sched = {
      id: "all-three-timings",
      name: "Cron, every, and intervalMs",
      schedule: { cron: "*/15 * * * *", every: "15m", intervalMs: 900_000 },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
    };

    const parsed = parseYaml(serializeYaml(sched));

    expect(parsed.schedule.cron).toBe("*/15 * * * *");
    expect(parsed.schedule.every).toBe("15m");
    expect(parsed.schedule.intervalMs).toBe(900_000);
  });
});
