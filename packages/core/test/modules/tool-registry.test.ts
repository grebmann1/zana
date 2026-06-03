// tool-registry — covers the in-memory MCP tool registry:
//   - registerModuleTools stores tools keyed by moduleId
//   - listModuleTools returns a flat list across all modules
//   - getModuleTool finds a tool by its prefixed name
//   - getToolsForModule returns only the tools for a given module
//   - unregisterModuleTools removes a module's tools
//   - clear wipes the entire registry
//   - invalid inputs are silently ignored

import { describe, it, expect, beforeEach } from "vitest";

const registry = require("@zana-ai/core/src/modules/tool-registry.ts");

const {
  registerModuleTools,
  unregisterModuleTools,
  listModuleTools,
  getModuleTool,
  getToolsForModule,
  clear,
} = registry;

const makeTool = (name: string, moduleId: string) => ({
  name,
  description: `desc for ${name}`,
  inputSchema: { type: "object", properties: {} },
  moduleId,
});

beforeEach(() => {
  clear();
});

describe("registerModuleTools", () => {
  it("stores tools and makes them visible via listModuleTools", () => {
    const tool = makeTool("zana_alpha_doThing", "alpha");
    registerModuleTools("alpha", [tool]);
    expect(listModuleTools()).toHaveLength(1);
    expect(listModuleTools()[0].name).toBe("zana_alpha_doThing");
  });

  it("silently ignores missing moduleId", () => {
    registerModuleTools("", [makeTool("zana_x_t", "x")]);
    expect(listModuleTools()).toHaveLength(0);
  });

  it("silently ignores non-array tools argument", () => {
    registerModuleTools("alpha", null as any);
    expect(listModuleTools()).toHaveLength(0);
  });

  it("overwrites a previous registration for the same moduleId", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_old", "alpha")]);
    registerModuleTools("alpha", [makeTool("zana_alpha_new", "alpha")]);
    const all = listModuleTools();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("zana_alpha_new");
  });
});

describe("listModuleTools", () => {
  it("returns empty array when registry is empty", () => {
    expect(listModuleTools()).toEqual([]);
  });

  it("returns flat list across multiple modules", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_a", "alpha"), makeTool("zana_alpha_b", "alpha")]);
    registerModuleTools("beta", [makeTool("zana_beta_a", "beta")]);
    expect(listModuleTools()).toHaveLength(3);
  });
});

describe("getModuleTool", () => {
  it("finds a tool by its prefixed name", () => {
    const tool = makeTool("zana_alpha_doThing", "alpha");
    registerModuleTools("alpha", [tool]);
    expect(getModuleTool("zana_alpha_doThing")).toMatchObject({ name: "zana_alpha_doThing" });
  });

  it("returns null for an unknown tool name", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_doThing", "alpha")]);
    expect(getModuleTool("zana_alpha_missing")).toBeNull();
  });

  it("returns null when registry is empty", () => {
    expect(getModuleTool("anything")).toBeNull();
  });
});

describe("getToolsForModule", () => {
  it("returns only tools belonging to the requested module", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_t", "alpha")]);
    registerModuleTools("beta", [makeTool("zana_beta_t", "beta")]);
    const alphaTools = getToolsForModule("alpha");
    expect(alphaTools).toHaveLength(1);
    expect(alphaTools[0].moduleId).toBe("alpha");
  });

  it("returns empty array for unknown moduleId", () => {
    expect(getToolsForModule("nonexistent")).toEqual([]);
  });
});

describe("unregisterModuleTools", () => {
  it("removes a registered module's tools from the list", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_t", "alpha")]);
    unregisterModuleTools("alpha");
    expect(listModuleTools()).toHaveLength(0);
  });

  it("does not affect other modules when one is removed", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_t", "alpha")]);
    registerModuleTools("beta", [makeTool("zana_beta_t", "beta")]);
    unregisterModuleTools("alpha");
    expect(listModuleTools()).toHaveLength(1);
    expect(listModuleTools()[0].moduleId).toBe("beta");
  });

  it("is a no-op for an unknown moduleId", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_t", "alpha")]);
    unregisterModuleTools("unknown");
    expect(listModuleTools()).toHaveLength(1);
  });
});

describe("clear", () => {
  it("empties the registry completely", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_t", "alpha")]);
    registerModuleTools("beta", [makeTool("zana_beta_t", "beta")]);
    clear();
    expect(listModuleTools()).toHaveLength(0);
  });
});
