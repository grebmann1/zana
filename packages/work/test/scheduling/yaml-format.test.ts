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
  });

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
});
