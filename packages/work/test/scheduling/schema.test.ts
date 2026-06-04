// Schedule schema validation tests.
import { describe, it, expect } from "vitest";
import {
  validateSchedule,
  resolveHistoryConfig,
  HISTORY_RETAIN_MAX,
} from "@zana-ai/work/src/scheduling/schema.ts";

const valid = () => ({
  id: "test",
  name: "Test",
  enabled: true,
  schedule: { every: "5m" },
  action: { type: "spawn-agent", profileId: "researcher", prompt: "hi" },
});

describe("validateSchedule", () => {
  it("accepts a minimal valid schedule", () => {
    const issues = validateSchedule(valid());
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("requires id and name", () => {
    const errs = (s: any) =>
      validateSchedule(s).filter((i) => i.level === "error").map((i) => i.field);
    expect(errs({ ...valid(), id: undefined })).toContain("id");
    expect(errs({ ...valid(), name: undefined })).toContain("name");
  });

  it("requires action with valid type", () => {
    expect(
      validateSchedule({ ...valid(), action: undefined })
        .some((i) => i.level === "error" && i.field === "action"),
    ).toBe(true);
    expect(
      validateSchedule({ ...valid(), action: { type: "evil-eval" } })
        .some((i) => i.level === "error" && i.field === "action.type"),
    ).toBe(true);
  });

  it("requires at least one trigger when enabled", () => {
    const issues = validateSchedule({
      ...valid(),
      schedule: {},
    });
    expect(issues.some((i) => i.level === "error" && i.field === "schedule")).toBe(true);
  });

  it("disabled schedule may omit trigger (manual-only)", () => {
    const issues = validateSchedule({
      ...valid(),
      enabled: false,
      schedule: {},
    });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("warns on unknown top-level fields", () => {
    const issues = validateSchedule({ ...valid(), bogusField: 1 });
    expect(issues.some((i) => i.level === "warning" && i.field === "bogusField")).toBe(true);
  });

  it("warns on unknown schedule.* fields", () => {
    const issues = validateSchedule({
      ...valid(),
      schedule: { every: "5m", typo: "x" },
    });
    expect(issues.some((i) => i.level === "warning" && i.field === "schedule.typo")).toBe(true);
  });

  it("rejects history with non-boolean enabled", () => {
    expect(
      validateSchedule({ ...valid(), history: { enabled: "yes" } as any })
        .some((i) => i.level === "error" && i.field === "history.enabled"),
    ).toBe(true);
  });

  it("rejects history.retain out of range", () => {
    expect(
      validateSchedule({ ...valid(), history: { retain: -1 } })
        .some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(true);
    expect(
      validateSchedule({ ...valid(), history: { retain: HISTORY_RETAIN_MAX + 1 } })
        .some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(true);
  });

  it("returns clean error on null/non-object input", () => {
    const issues = validateSchedule(null);
    expect(issues[0]).toMatchObject({ level: "error", field: "(root)" });
  });

  it("rejects history: null with an error on field 'history'", () => {
    // The source explicitly guards `raw.history === null` in addition to the
    // typeof check, because `typeof null === "object"`. Ensure that path fires.
    const issues = validateSchedule({ ...valid(), history: null as any });
    expect(issues.some((i) => i.level === "error" && i.field === "history")).toBe(true);
  });

  it("does not warn on _-prefixed internal marker fields", () => {
    // Fields starting with '_' are treated as internal markers and must be
    // silently ignored rather than surfaced as "unknown field" warnings.
    const issues = validateSchedule({ ...valid(), _internalMarker: true });
    expect(issues.some((i) => i.field === "_internalMarker")).toBe(false);
  });
});

describe("resolveHistoryConfig", () => {
  it("applies defaults when schedule has no history block", () => {
    const cfg = resolveHistoryConfig({});
    expect(cfg).toEqual({ enabled: true, retain: 10 });
  });

  it("respects explicit history.enabled=false", () => {
    expect(resolveHistoryConfig({ history: { enabled: false } }).enabled).toBe(false);
  });

  it("clamps retain to [0, HISTORY_RETAIN_MAX]", () => {
    expect(resolveHistoryConfig({ history: { retain: -5 } }).retain).toBe(0);
    expect(
      resolveHistoryConfig({ history: { retain: HISTORY_RETAIN_MAX + 999 } }).retain,
    ).toBe(HISTORY_RETAIN_MAX);
  });

  it("floors fractional retain", () => {
    expect(resolveHistoryConfig({ history: { retain: 7.9 } }).retain).toBe(7);
  });

  it("ignores non-numeric retain", () => {
    expect(resolveHistoryConfig({ history: { retain: "ten" } }).retain).toBe(10);
  });
});
