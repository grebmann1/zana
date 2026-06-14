// Unit tests for packages/mcp/src/registrations/index.ts
//
// collectStaticTools() aggregates every domain's tools[] into one flat array.
// collectHandlers()    aggregates every domain's handlers into one record.
//
// Invariants tested:
//  1. Both functions return non-empty results.
//  2. Tool names are globally unique — no duplicate across domains.
//  3. Every tool has the required shape: name, description, inputSchema.
//  4. Every tool in collectStaticTools() has a matching handler in collectHandlers().
//     (The reverse is intentionally NOT held: swarm handlers are always registered
//      but swarm tools are empty when ZANA_MASTER_MODE=false — by design.)
//  5. Representative spot-check: one always-present tool from each key domain.
//  6. Every handler value is callable (is a function).
//
// NOTE: registrations/deliberation.ts uses a top-level CJS require without
// extension that Vite's SSR runner cannot resolve from source (documented in
// deliberation.test.ts). We mock that one module so the aggregator can be
// imported without touching any other production source.

import { describe, it, expect, vi } from "vitest";

// Stub for the deliberation domain — provides the minimal ToolDomain shape.
vi.mock("../../src/registrations/deliberation.ts", () => ({
  deliberation: {
    tools: [
      {
        name: "zana_deliberation_stub",
        description: "Stub deliberation tool for aggregator tests",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    handlers: {
      zana_deliberation_stub: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  },
}));

// Import after mock registration.
import {
  collectStaticTools,
  collectHandlers,
} from "../../src/registrations/index.ts";

describe("collectStaticTools()", () => {
  it("returns a non-empty array", () => {
    const tools = collectStaticTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool has name, description, and inputSchema", () => {
    for (const tool of collectStaticTools()) {
      expect(typeof tool.name, "tool.name must be a string").toBe("string");
      expect(tool.name.length, "tool name must not be empty").toBeGreaterThan(0);
      expect(typeof tool.description, `${tool.name} missing description`).toBe("string");
      expect(tool.description.length, `${tool.name} description must not be empty`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
    }
  });

  it("tool names are globally unique across all domains", () => {
    const names = collectStaticTools().map((t) => t.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates, `duplicate tool names: ${duplicates.join(", ")}`).toHaveLength(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("preserves the documented ALL_DOMAINS order in the flattened output", () => {
    // index.ts documents that domain order is preserved in `tools/list` so any
    // out-of-band consumer relying on positional ordering keeps working. Assert
    // that representative always-present tools appear in their ALL_DOMAINS order:
    // profiles → skills → tickets → sprints → teams → artifacts → schedules → deliberation.
    const names = collectStaticTools().map((t) => t.name);
    const orderedRepresentatives = [
      "zana_list_profiles",     // profiles
      "zana_list_skills",       // skills
      "zana_ticket_create",     // tickets
      "zana_sprint_create",     // sprints
      "zana_list_teams",        // teams
      "zana_artifact_create",   // artifacts
      "zana_schedule_list",     // schedules
      "zana_deliberation_stub", // deliberation (stub, last)
    ];
    const indices = orderedRepresentatives.map((n) => {
      const idx = names.indexOf(n);
      expect(idx, `representative tool "${n}" must be present`).toBeGreaterThanOrEqual(0);
      return idx;
    });
    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i],
        `"${orderedRepresentatives[i]}" must come after "${orderedRepresentatives[i - 1]}"`,
      ).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("includes one representative always-present tool from each key domain", () => {
    const names = new Set(collectStaticTools().map((t) => t.name));
    // These tools are non-gated (present regardless of ZANA_DAEMON_TOOLS / ZANA_MASTER_MODE).
    const expected: [string, string][] = [
      ["zana_list_profiles",     "profiles"],
      ["zana_list_skills",       "skills"],
      ["zana_ticket_create",     "tickets"],
      ["zana_sprint_create",     "sprints"],
      ["zana_list_teams",        "teams"],
      ["zana_schedule_list",     "schedules"],
      ["zana_artifact_create",   "artifacts"],
      ["zana_deliberation_stub", "deliberation (stub)"],
    ];
    for (const [name, domain] of expected) {
      expect(names.has(name), `expected always-present tool "${name}" from domain "${domain}"`).toBe(true);
    }
  });
});

describe("collectHandlers()", () => {
  it("returns a non-empty record", () => {
    const handlers = collectHandlers();
    expect(typeof handlers).toBe("object");
    expect(Object.keys(handlers).length).toBeGreaterThan(0);
  });

  it("every tool in collectStaticTools() has a handler in collectHandlers()", () => {
    // Forward direction: tools → handlers must be 1:1.
    // (Reverse is not required: swarm handlers exist without tools when ZANA_MASTER_MODE=false.)
    const handlers = collectHandlers();
    for (const tool of collectStaticTools()) {
      expect(
        typeof handlers[tool.name],
        `tool "${tool.name}" is missing its handler`,
      ).toBe("function");
    }
  });

  it("every handler value is a function", () => {
    for (const [name, fn] of Object.entries(collectHandlers())) {
      expect(typeof fn, `handler "${name}" should be a function`).toBe("function");
    }
  });
});
