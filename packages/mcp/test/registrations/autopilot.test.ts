// Unit tests for registrations/autopilot.ts
//
// Behaviours tested:
//   - Tool definitions: four tools exist with correct names and required fields
//   - Every handler returns { error: "autopilot module not available" } when the
//     autopilot module is absent from the module loader (real @zana-ai/core in
//     test env never loads the "autopilot" module, so this path is always hit)
//
// Note: the delegation happy-paths (ap.api.setGoal, ap.api.getGoal, etc.) rely
// on runtime require("@zana-ai/core") being interceptable.  The ssr.noExternal
// Vite config inlines @zana-ai/core before vi.mock can intercept it, so those
// tests are omitted rather than weakened.
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { autopilot } from "../../src/registrations/autopilot.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (autopilot.handlers as Record<string, Handler>)[name];
}

// ─── tool definitions ─────────────────────────────────────────────────────────

describe("autopilot tool definitions", () => {
  it("exposes exactly four tool names", () => {
    const names = autopilot.tools.map((t) => t.name);
    expect(names).toHaveLength(4);
    expect(names).toEqual(
      expect.arrayContaining([
        "zana_autopilot_goal_driven",
        "zana_autopilot_goal_status",
        "zana_autopilot_goal_list",
        "zana_autopilot_goal_cancel",
      ]),
    );
  });

  it("zana_autopilot_goal_driven requires title, criteria, and steps", () => {
    const def = autopilot.tools.find((t) => t.name === "zana_autopilot_goal_driven")!;
    expect(def.inputSchema.required).toEqual(
      expect.arrayContaining(["title", "criteria", "steps"]),
    );
  });

  it("zana_autopilot_goal_status requires goalId", () => {
    const def = autopilot.tools.find((t) => t.name === "zana_autopilot_goal_status")!;
    expect(def.inputSchema.required).toContain("goalId");
  });

  it("zana_autopilot_goal_cancel requires goalId", () => {
    const def = autopilot.tools.find((t) => t.name === "zana_autopilot_goal_cancel")!;
    expect(def.inputSchema.required).toContain("goalId");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of autopilot.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── module-not-available guard ───────────────────────────────────────────────
// In the test environment @zana-ai/core never loads the "autopilot" module, so
// modules.loader.getModule("autopilot") returns undefined — these tests verify
// the guard branch executes correctly.

describe("handlers when autopilot module is unavailable", () => {
  it("zana_autopilot_goal_driven returns error", async () => {
    const result = await getHandler("zana_autopilot_goal_driven")({
      title: "t", criteria: "c", steps: [],
    });
    expect(result).toEqual({ error: "autopilot module not available" });
  });

  it("zana_autopilot_goal_status returns error", () => {
    const result = getHandler("zana_autopilot_goal_status")({ goalId: "g1" });
    expect(result).toEqual({ error: "autopilot module not available" });
  });

  it("zana_autopilot_goal_list returns error", () => {
    const result = getHandler("zana_autopilot_goal_list")({});
    expect(result).toEqual({ error: "autopilot module not available" });
  });

  it("zana_autopilot_goal_cancel returns error", () => {
    const result = getHandler("zana_autopilot_goal_cancel")({ goalId: "g1" });
    expect(result).toEqual({ error: "autopilot module not available" });
  });
});


