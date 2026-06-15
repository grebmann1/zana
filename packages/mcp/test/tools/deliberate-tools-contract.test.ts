// Contract tests for the deliberation MCP tool definitions (deliberate.ts).
//
// These exported objects ARE the public MCP surface: name + description +
// inputSchema shape are what clients see in tools/list. The behavior behind
// them is covered elsewhere; here we lock down the static contract so an
// accidental rename, dropped schema, or un-gated new tool is caught at CI time
// rather than leaking into the native tool surface. Pure & deterministic — no
// network, no Claude, no filesystem.

import { describe, it, expect } from "vitest";
import {
  DELIBERATION_TOOLS,
  deliberateTool,
  deliberationStatusTool,
  deliberationListTool,
  deliberationOverrideTool,
  deliberationCancelTool,
  deliberationNudgeTool,
} from "../../src/tools/deliberate.ts";
import { DAEMON_GATED_TOOL_NAMES } from "../../src/gating.ts";

describe("DELIBERATION_TOOLS contract", () => {
  it("collects exactly the six exported deliberation tool definitions", () => {
    expect(DELIBERATION_TOOLS).toEqual([
      deliberateTool,
      deliberationStatusTool,
      deliberationListTool,
      deliberationOverrideTool,
      deliberationCancelTool,
      deliberationNudgeTool,
    ]);
  });

  it("exposes the expected, stable tool names", () => {
    expect(DELIBERATION_TOOLS.map((t) => t.name)).toEqual([
      "zana_deliberate",
      "zana_deliberation_status",
      "zana_deliberation_list",
      "zana_deliberation_override",
      "zana_deliberate_cancel",
      "zana_deliberation_nudge",
    ]);
  });

  it("has unique tool names", () => {
    const names = DELIBERATION_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has a non-empty description and a well-formed object inputSchema", () => {
    for (const tool of DELIBERATION_TOOLS) {
      expect(tool.name, "name").toMatch(/^zana_/);
      expect(typeof tool.description, `${tool.name} description type`).toBe("string");
      expect(tool.description.length, `${tool.name} description non-empty`).toBeGreaterThan(0);

      const schema: any = tool.inputSchema;
      expect(schema, `${tool.name} inputSchema`).toBeTypeOf("object");
      expect(schema.type, `${tool.name} inputSchema.type`).toBe("object");
      expect(schema.properties, `${tool.name} inputSchema.properties`).toBeTypeOf("object");

      // Every name listed in `required` must be a declared property.
      const required: string[] = schema.required ?? [];
      for (const key of required) {
        expect(
          Object.prototype.hasOwnProperty.call(schema.properties, key),
          `${tool.name} required '${key}' is declared in properties`,
        ).toBe(true);
      }
    }
  });

  it("requires a deliberationId for every tool that operates on an existing deliberation", () => {
    const idScoped = [
      deliberationStatusTool,
      deliberationOverrideTool,
      deliberationCancelTool,
      deliberationNudgeTool,
    ];
    for (const tool of idScoped) {
      expect(tool.inputSchema.required, `${tool.name} requires deliberationId`).toContain(
        "deliberationId",
      );
    }
    // The starter tool requires the question, not an id.
    expect(deliberateTool.inputSchema.required).toEqual(["question"]);
  });

  it("gates every deliberation tool behind ZANA_DAEMON_TOOLS (daemon-only surface)", () => {
    // Invariant: deliberation is a daemon-path flow (covered natively by
    // /zana:council). A new tool added without a matching gate entry would
    // leak into the lean native surface — this catches that regression.
    for (const tool of DELIBERATION_TOOLS) {
      expect(
        DAEMON_GATED_TOOL_NAMES.has(tool.name),
        `${tool.name} must be listed in DAEMON_GATED_TOOL_NAMES`,
      ).toBe(true);
    }
  });
});
