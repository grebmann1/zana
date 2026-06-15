// schema-history-edge-cases — exercises branches in scheduling/schema.ts that
// are not reached by schema.test.ts:
//
//  1. validateSchedule rejects a non-integer history.retain (the
//     !Number.isInteger(r) guard on line 148).
//  2. resolveHistoryConfig returns defaults when the schedule arg is null,
//     undefined, or a non-object primitive — the null-guard on line 167.
//  3. validateSchedule surfaces an error on action.type when the action object
//     is present but has no type field (the !t branch on line 129).

import { describe, it, expect } from "vitest";
import {
  validateSchedule,
  resolveHistoryConfig,
  HISTORY_DEFAULTS,
} from "@zana-ai/work/src/scheduling/schema.ts";

const valid = () => ({
  id: "edge",
  name: "Edge case schedule",
  enabled: true,
  schedule: { every: "5m" },
  action: { type: "spawn-agent", profileId: "researcher", prompt: "go" },
});

// ── validateSchedule — non-integer history.retain ─────────────────────────

describe("validateSchedule — history.retain must be an integer", () => {
  it("rejects a float retain value (e.g. 1.5)", () => {
    const issues = validateSchedule({ ...valid(), history: { retain: 1.5 } });
    expect(
      issues.some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(true);
  });

  it("accepts retain=0 (boundary — min valid integer)", () => {
    const issues = validateSchedule({ ...valid(), history: { retain: 0 } });
    expect(
      issues.some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(false);
  });

  it("accepts retain equal to HISTORY_RETAIN_MAX (boundary — max valid integer)", () => {
    const { HISTORY_RETAIN_MAX } = require("@zana-ai/work/src/scheduling/schema.ts");
    const issues = validateSchedule({ ...valid(), history: { retain: HISTORY_RETAIN_MAX } });
    expect(
      issues.some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(false);
  });

  it("rejects a non-numeric retain (the typeof r !== 'number' guard)", () => {
    // Distinct branch from the float / range guards: validateSchedule must
    // reject a string retain outright. This pins the intentional contrast with
    // resolveHistoryConfig, which silently falls back to the default for a
    // non-numeric retain rather than surfacing an error.
    const issues = validateSchedule({ ...valid(), history: { retain: "10" } as any });
    expect(
      issues.some((i) => i.level === "error" && i.field === "history.retain"),
    ).toBe(true);
  });
});

// ── resolveHistoryConfig — null / undefined / primitive schedule ───────────

describe("resolveHistoryConfig — null-guard on schedule input", () => {
  it("returns defaults when schedule is null", () => {
    expect(resolveHistoryConfig(null)).toEqual(HISTORY_DEFAULTS);
  });

  it("returns defaults when schedule is undefined", () => {
    expect(resolveHistoryConfig(undefined)).toEqual(HISTORY_DEFAULTS);
  });

  it("returns defaults when schedule is a string (non-object)", () => {
    expect(resolveHistoryConfig("not-an-object" as any)).toEqual(HISTORY_DEFAULTS);
  });

  it("returns defaults when schedule is 0 (falsy non-object)", () => {
    expect(resolveHistoryConfig(0 as any)).toEqual(HISTORY_DEFAULTS);
  });
});

// ── validateSchedule — action present but missing type field ──────────────

describe("validateSchedule — action.type missing (action object has no type)", () => {
  it("errors on action.type when action is an object with no type field", () => {
    const issues = validateSchedule({ ...valid(), action: {} as any });
    expect(
      issues.some((i) => i.level === "error" && i.field === "action.type"),
    ).toBe(true);
  });
});
