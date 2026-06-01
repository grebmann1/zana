import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
  everShorthandToMs,
  msToEvery,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("scheduler-yaml: everShorthandToMs", () => {
  it("converts simple units", () => {
    expect(everShorthandToMs("5m")).toBe(300_000);
    expect(everShorthandToMs("1h")).toBe(3_600_000);
    expect(everShorthandToMs("30s")).toBe(30_000);
    expect(everShorthandToMs("2d")).toBe(2 * 86_400_000);
    expect(everShorthandToMs("500ms")).toBe(500);
  });

  it("tolerates whitespace and case", () => {
    expect(everShorthandToMs(" 10M ")).toBe(600_000);
    expect(everShorthandToMs("3H")).toBe(3 * 3_600_000);
  });

  it("throws on bad input", () => {
    expect(() => everShorthandToMs("")).toThrow();
    expect(() => everShorthandToMs("abc")).toThrow();
    expect(() => everShorthandToMs("0m")).toThrow();
    expect(() => everShorthandToMs("-5m")).toThrow();
    expect(() => everShorthandToMs("5x")).toThrow();
    // @ts-expect-error — explicit bad type
    expect(() => everShorthandToMs(123)).toThrow();
  });
});

describe("scheduler-yaml: msToEvery", () => {
  it("picks the largest matching unit", () => {
    expect(msToEvery(86_400_000)).toBe("1d");
    expect(msToEvery(3_600_000)).toBe("1h");
    expect(msToEvery(300_000)).toBe("5m");
    expect(msToEvery(30_000)).toBe("30s");
    expect(msToEvery(123)).toBe("123ms");
  });

  it("throws on bad ms input", () => {
    expect(() => msToEvery(0)).toThrow();
    expect(() => msToEvery(-1)).toThrow();
    // @ts-expect-error — explicit bad type
    expect(() => msToEvery("foo")).toThrow();
  });
});

describe("scheduler-yaml: serialize/parse roundtrip", () => {
  it("roundtrips a cron schedule with all fields", () => {
    const schedule = {
      id: "abc-123",
      name: "Daily test gap audit",
      description: "Spawn test-writer once a day",
      enabled: true,
      schedule: { cron: "0 2 * * *" },
      action: {
        type: "spawn-agent",
        profileId: "test-writer",
        prompt: "Scan the project for files that lack tests.",
      },
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      status: {
        lastRunAt: "2026-05-18T02:00:00.000Z",
        lastRunResult: "success",
        nextRunAt: "2026-05-19T02:00:00.000Z",
        runCount: 17,
      },
    };

    const yaml = serializeYaml(schedule);
    expect(yaml).toMatch(/Zana scheduled task/); // header preserved
    expect(yaml).toMatch(/cron:\s*['"]?0 2 \* \* \*['"]?/);

    const parsed = parseYaml(yaml);
    expect(parsed).not.toBeNull();
    expect(parsed.id).toBe("abc-123");
    expect(parsed.name).toBe("Daily test gap audit");
    expect(parsed.schedule.cron).toBe("0 2 * * *");
    expect(parsed.action.type).toBe("spawn-agent");
    expect(parsed.action.profileId).toBe("test-writer");
    expect(parsed.status.runCount).toBe(17);
    expect(parsed.status.lastRunResult).toBe("success");
  });

  it("roundtrips a schedule with `every` shorthand", () => {
    const schedule = {
      id: "every-1",
      name: "ping",
      enabled: true,
      schedule: { every: "5m" },
      action: { type: "command", command: "echo hi" },
    };
    const yaml = serializeYaml(schedule);
    const parsed = parseYaml(yaml);
    expect(parsed.schedule.every).toBe("5m");
    expect(parsed.action.command).toBe("echo hi");
  });

  it("parse with missing optional fields tolerated", () => {
    const yaml = `id: minimal-1\nname: minimal\nschedule:\n  cron: "* * * * *"\naction:\n  type: command\n  command: "true"\n`;
    const parsed = parseYaml(yaml);
    expect(parsed).not.toBeNull();
    expect(parsed.id).toBe("minimal-1");
    // No description, no enabled, no status — should still parse fine
    expect(parsed.description).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it("parseYaml returns null on malformed YAML rather than throwing", () => {
    // Unclosed quote / structurally invalid
    expect(parseYaml("name: \"unterminated\nfoo: bar: : :")).toBeNull();
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("just-a-string")).toBeNull();
    // @ts-expect-error — explicit bad type
    expect(parseYaml(undefined)).toBeNull();
  });

  it("preserves legacy flat lastRunAt under status block", () => {
    const schedule = {
      id: "legacy-1",
      name: "legacy",
      enabled: true,
      schedule: { intervalMs: 60_000 },
      action: { type: "command", command: "echo legacy" },
      lastRunAt: "2026-05-18T00:00:00.000Z",
      lastRunResult: "success",
      runCount: 3,
    };
    const yaml = serializeYaml(schedule);
    const parsed = parseYaml(yaml);
    expect(parsed.status.lastRunAt).toBe("2026-05-18T00:00:00.000Z");
    expect(parsed.status.lastRunResult).toBe("success");
    expect(parsed.status.runCount).toBe(3);
  });
});
