// Regression pin for the "prompt" action-type alias in schema.ts.
//
// ACTION_TYPES includes "prompt" as an alias for "spawn-agent" (line 37-42
// of schema.ts), but no existing test ever passes `action.type: "prompt"` to
// validateSchedule.  Without a test, a future refactor could accidentally drop
// the alias from ACTION_TYPES and break schedules that rely on it.
//
// Coverage:
//   - validateSchedule accepts action.type "prompt" with zero errors
//   - all ACTION_TYPES values produce zero errors when used in a valid schedule
//   - action.type "spawn-agent" still passes (baseline, guards the list itself)
//   - an invalid type still produces an error (boundary contrast)
import { describe, it, expect } from "vitest";
import {
  validateSchedule,
  ACTION_TYPES,
} from "@zana-ai/work/src/scheduling/schema.ts";

const baseSchedule = (actionType: string) => ({
  id: "alias-test",
  name: "Alias Test",
  enabled: true,
  schedule: { every: "5m" },
  action: { type: actionType, profileId: "worker", prompt: "go" },
});

describe("validateSchedule — action.type 'prompt' alias", () => {
  it("accepts action.type 'prompt' with no errors", () => {
    const issues = validateSchedule(baseSchedule("prompt"));
    const errors = issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("'prompt' alias produces same error count as 'spawn-agent'", () => {
    const errorsSpawn = validateSchedule(baseSchedule("spawn-agent"))
      .filter((i) => i.level === "error");
    const errorsPrompt = validateSchedule(baseSchedule("prompt"))
      .filter((i) => i.level === "error");
    expect(errorsPrompt.length).toBe(errorsSpawn.length);
  });
});

describe("validateSchedule — every ACTION_TYPES value is accepted", () => {
  // This iterates the canonical ACTION_TYPES tuple so a future addition that
  // works in production but lacks test coverage is immediately flagged.
  for (const type of ACTION_TYPES) {
    it(`accepts action.type '${type}' with no errors`, () => {
      const issues = validateSchedule(baseSchedule(type));
      const errors = issues.filter((i) => i.level === "error");
      expect(
        errors,
        `action.type '${type}' should be valid but got errors: ${JSON.stringify(errors)}`,
      ).toEqual([]);
    });
  }
});

describe("validateSchedule — invalid action.type still errors (boundary contrast)", () => {
  it("rejects an unknown action.type", () => {
    const issues = validateSchedule(baseSchedule("notify"));
    const actionTypeError = issues.find(
      (i) => i.level === "error" && i.field === "action.type",
    );
    expect(actionTypeError).toBeDefined();
    expect(actionTypeError!.message).toMatch(/must be one of/);
  });
});
