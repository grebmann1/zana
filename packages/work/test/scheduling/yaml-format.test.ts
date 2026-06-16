// yaml-format unit tests — every-shorthand parsing, YAML round-trip, msToEvery.
import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
  everShorthandToMs,
  msToEvery,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("everShorthandToMs", () => {
  it("parses ms / s / m / h / d", () => {
    expect(everShorthandToMs("500ms")).toBe(500);
    expect(everShorthandToMs("30s")).toBe(30_000);
    expect(everShorthandToMs("5m")).toBe(300_000);
    expect(everShorthandToMs("2h")).toBe(7_200_000);
    expect(everShorthandToMs("1d")).toBe(86_400_000);
  });

  it("accepts whitespace and case", () => {
    expect(everShorthandToMs("  10M  ")).toBe(600_000);
    expect(everShorthandToMs("3 H")).toBe(10_800_000);
  });

  it("rejects junk and negatives", () => {
    expect(() => everShorthandToMs("")).toThrow();
    expect(() => everShorthandToMs("abc")).toThrow();
    expect(() => everShorthandToMs("0m")).toThrow();
    expect(() => everShorthandToMs("-5m")).toThrow();
    expect(() => everShorthandToMs("5y")).toThrow();
    expect(() => everShorthandToMs(null as any)).toThrow();
  });
});

describe("msToEvery", () => {
  it("picks the largest clean unit", () => {
    expect(msToEvery(86_400_000)).toBe("1d");
    expect(msToEvery(3_600_000)).toBe("1h");
    expect(msToEvery(60_000)).toBe("1m");
    expect(msToEvery(1000)).toBe("1s");
    expect(msToEvery(500)).toBe("500ms");
  });

  it("rejects invalid input", () => {
    expect(() => msToEvery(0)).toThrow();
    expect(() => msToEvery(-1)).toThrow();
    expect(() => msToEvery(NaN)).toThrow();
    expect(() => msToEvery("abc" as any)).toThrow();
  });

  it("rejects Infinity", () => {
    // !Number.isFinite(Infinity) is true, so the guard on line 139 should throw.
    expect(() => msToEvery(Infinity)).toThrow(/invalid ms value/);
  });

  it("round-trips with everShorthandToMs for clean units", () => {
    for (const s of ["1d", "2h", "5m", "30s", "500ms"]) {
      expect(msToEvery(everShorthandToMs(s))).toBe(s);
    }
  });
});

describe("YAML round-trip", () => {
  it("serialize → parse preserves a typical schedule", () => {
    const original = {
      id: "test-id",
      name: "Test schedule",
      description: "Demo",
      enabled: true,
      schedule: { every: "5m", intervalMs: 300_000 },
      action: { type: "spawn-agent", profileId: "researcher", prompt: "hi" },
      ownerId: "user-1",
      ownerName: "User One",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: { lastRunAt: null, lastRunResult: null, nextRunAt: null, runCount: 0 },
    };
    const yaml = serializeYaml(original);
    expect(yaml).toContain("Zana scheduled task");
    const parsed = parseYaml(yaml);
    expect(parsed).toMatchObject(original);
    // serialize→parse is fully synchronous and runs in <1ms; the generous
    // explicit timeout guards only against fork-pool starvation under the
    // heavily-parallel full-suite run (where this test has spuriously hit the
    // default 5s budget despite passing instantly in isolation).
  }, 30_000);

  it("parseYaml returns null on garbage", () => {
    expect(parseYaml("::: not yaml :::")).toBeNull();
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("just a string")).toBeNull();
    expect(parseYaml(null as any)).toBeNull();
  });

  it("serializeYaml normalizes legacy flat fields into the schedule block", () => {
    const flat = {
      id: "t",
      name: "t",
      cron: "*/5 * * * *",
      action: { type: "command", command: ["echo", "x"] },
    };
    const yaml = serializeYaml(flat);
    const parsed = parseYaml(yaml);
    expect(parsed.schedule.cron).toBe("*/5 * * * *");
  });

  it("serializeYaml rejects non-object input", () => {
    expect(() => serializeYaml(null as any)).toThrow();
    expect(() => serializeYaml("hi" as any)).toThrow();
  });

  it("serializeYaml normalizes legacy flat intervalMs into the schedule block", () => {
    // The legacy flat `intervalMs` field (used before the nested schedule block was
    // introduced) must be lifted into `schedule.intervalMs` so that pickBackend()
    // can read it from a single location. This mirrors the `cron` flat-field
    // normalization already tested above.
    const flat = {
      id: "legacy-interval",
      name: "Legacy interval schedule",
      intervalMs: 300_000,
      action: { type: "spawn-agent", profileId: "researcher", prompt: "go" },
    };
    const yaml = serializeYaml(flat);
    const parsed = parseYaml(yaml);
    // The flat intervalMs should appear inside the `schedule` block.
    expect(parsed.schedule).toBeDefined();
    expect(parsed.schedule.intervalMs).toBe(300_000);
    // The top-level flat field should NOT be duplicated at the root.
    expect(parsed.intervalMs).toBeUndefined();
  });

  it("serializeYaml preserves the history block when provided", () => {
    // Lines 59-62 of yaml-format.ts pass the `history` object through to the
    // serialised representation unchanged. This path was previously untested.
    const sched = {
      id: "hist-sched",
      name: "History schedule",
      schedule: { every: "1h", intervalMs: 3_600_000 },
      action: { type: "spawn-agent", profileId: "worker", prompt: "run" },
      history: { maxEntries: 20, includeOutput: true },
    };
    const yaml = serializeYaml(sched);
    const parsed = parseYaml(yaml);
    expect(parsed.history).toBeDefined();
    expect(parsed.history.maxEntries).toBe(20);
    expect(parsed.history.includeOutput).toBe(true);
  });

  it("serializeYaml lifts legacy flat status fields into the status block", () => {
    // Lines 75-81 of yaml-format.ts pull legacy flat status fields (lastRunAt,
    // lastRunResult, nextRunAt, runCount) up from the root into the nested status
    // block — mirroring how cron/intervalMs are lifted into the schedule block.
    // This path was untested; the previous round-trip test only exercises the
    // already-nested form.
    const flat = {
      id: "legacy-status",
      name: "Legacy status schedule",
      lastRunAt: "2026-01-01T12:00:00.000Z",
      lastRunResult: "ok",
      nextRunAt: "2026-01-01T13:00:00.000Z",
      runCount: 7,
      action: { type: "spawn-agent", profileId: "researcher", prompt: "go" },
    };
    const yaml = serializeYaml(flat);
    const parsed = parseYaml(yaml);
    // All four legacy fields must be nested under status.
    expect(parsed.status).toBeDefined();
    expect(parsed.status.lastRunAt).toBe("2026-01-01T12:00:00.000Z");
    expect(parsed.status.lastRunResult).toBe("ok");
    expect(parsed.status.nextRunAt).toBe("2026-01-01T13:00:00.000Z");
    expect(parsed.status.runCount).toBe(7);
    // The flat fields must NOT appear at the document root.
    expect(parsed.lastRunAt).toBeUndefined();
    expect(parsed.lastRunResult).toBeUndefined();
    expect(parsed.nextRunAt).toBeUndefined();
    expect(parsed.runCount).toBeUndefined();
  });

  it("serializeYaml preserves every shorthand alone (no intervalMs) in schedule block", () => {
    // User-authored YAML files commonly use `every: 15m` without explicitly
    // specifying `intervalMs` — the daemon resolves it at runtime via
    // readScheduleBlock / everShorthandToMs.  serializeYaml must preserve
    // `every` verbatim and must NOT silently inject a null/undefined
    // `intervalMs` key that would confuse downstream readers.
    const sched = {
      id: "every-only",
      name: "Every-only schedule",
      enabled: true,
      schedule: { every: "15m" },
      action: { type: "spawn-agent", profileId: "researcher", prompt: "run" },
    };
    const yaml = serializeYaml(sched);
    const parsed = parseYaml(yaml);

    // schedule block must exist and carry exactly `every`
    expect(parsed.schedule).toBeDefined();
    expect(parsed.schedule.every).toBe("15m");
    // intervalMs must NOT appear — it was never set on the input
    expect(parsed.schedule.intervalMs).toBeUndefined();
    // `every` must NOT leak to the document root
    expect(parsed.every).toBeUndefined();
    // top-level shape is preserved
    expect(parsed.id).toBe("every-only");
    expect(parsed.enabled).toBe(true);
  });
});
