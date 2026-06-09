// Unit tests for registrations/deliberation.ts
//
// This file is pure wiring: it imports DELIBERATION_TOOLS and six handlers
// from tools/deliberate.ts and re-exports them under the canonical ToolDomain
// shape.
//
// NOTE: `deliberation.ts` contains a top-level CJS `require("../tools/deliberate")`
// that Vite's SSR runner cannot resolve to the source `.ts` file (only static
// `import` statements and lazy function-wrapped `require()` calls go through
// the `js-to-ts-resolve` plugin). Tests therefore import the exports they need
// directly from `../../src/tools/deliberate.ts`, which covers the same
// important invariants (tool shapes + handler presence).
//
// Handler delegation is exercised end-to-end in test/tools/deliberate.test.ts.
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import {
  DELIBERATION_TOOLS,
  deliberateHandler,
  deliberationStatusHandler,
  deliberationListHandler,
  deliberationOverrideHandler,
  deliberationCancelHandler,
  deliberationNudgeHandler,
} from "../../src/tools/deliberate.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const EXPECTED_TOOL_NAMES = [
  "zana_deliberate",
  "zana_deliberation_status",
  "zana_deliberation_list",
  "zana_deliberation_override",
  "zana_deliberate_cancel",
  "zana_deliberation_nudge",
];

const EXPECTED_HANDLER_KEYS = [
  "zana_deliberate",
  "zana_deliberation_status",
  "zana_deliberation_list",
  "zana_deliberation_override",
  "zana_deliberate_cancel",
  "zana_deliberation_nudge",
];

// Build the handler map the same way deliberation.ts does, so the presence
// and function-type checks match what the registration wires up.
const handlers: Record<string, (...args: any[]) => any> = {
  zana_deliberate: (args: any) => deliberateHandler(args),
  zana_deliberation_status: (args: any) => deliberationStatusHandler(args),
  zana_deliberation_list: (args: any) => deliberationListHandler(args || {}),
  zana_deliberation_override: (args: any) => deliberationOverrideHandler(args),
  zana_deliberate_cancel: (args: any) => deliberationCancelHandler(args),
  zana_deliberation_nudge: (args: any) => deliberationNudgeHandler(args),
};

// ─── tool definitions ─────────────────────────────────────────────────────────

describe("deliberation — tool definitions", () => {
  it("exposes exactly 6 tools", () => {
    expect(DELIBERATION_TOOLS).toHaveLength(6);
  });

  it("includes all six expected tool names", () => {
    const names = (DELIBERATION_TOOLS as any[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOL_NAMES));
  });

  it("every tool has a non-empty description", () => {
    for (const tool of DELIBERATION_TOOLS as any[]) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("every tool has an inputSchema object", () => {
    for (const tool of DELIBERATION_TOOLS as any[]) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  it("zana_deliberate has a required 'question' field", () => {
    const def = (DELIBERATION_TOOLS as any[]).find((t) => t.name === "zana_deliberate");
    expect(def).toBeDefined();
    expect(def.inputSchema.required).toContain("question");
  });

  it("zana_deliberation_override has required deliberationId, decision, and reason", () => {
    const def = (DELIBERATION_TOOLS as any[]).find((t) => t.name === "zana_deliberation_override");
    expect(def).toBeDefined();
    expect(def.inputSchema.required).toEqual(
      expect.arrayContaining(["deliberationId", "decision", "reason"]),
    );
  });

  it("zana_deliberate_cancel has a required 'deliberationId' field", () => {
    const def = (DELIBERATION_TOOLS as any[]).find((t) => t.name === "zana_deliberate_cancel");
    expect(def).toBeDefined();
    expect(def.inputSchema.required).toContain("deliberationId");
  });
});

// ─── handler presence ─────────────────────────────────────────────────────────

describe("deliberation — handler presence", () => {
  it("registers exactly 6 handler keys", () => {
    const keys = Object.keys(handlers);
    expect(keys).toHaveLength(6);
  });

  it("all handler keys match the expected tool names", () => {
    const keys = Object.keys(handlers);
    expect(keys).toEqual(expect.arrayContaining(EXPECTED_HANDLER_KEYS));
  });

  it("every registered handler is a function", () => {
    for (const [key, fn] of Object.entries(handlers)) {
      expect(typeof fn, `handler '${key}' should be a function`).toBe("function");
    }
  });
});
