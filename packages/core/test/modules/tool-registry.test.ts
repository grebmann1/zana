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

  // listModuleTools builds a NEW array each call (`all.push(...tools)` in
  // tool-registry.ts), so the returned list is a defensive copy: a caller that
  // mutates it must NOT corrupt the internal registry. Every other test only
  // reads the result, so a regression that returned an internal array
  // reference (e.g. a single cached/flattened array) would pass them all while
  // letting one consumer's `.push()`/`.pop()` leak into every other consumer.
  // Pins both the fresh-instance and the isolation contract.
  it("returns a fresh, caller-isolated array that cannot mutate the registry", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_a", "alpha")]);

    const first = listModuleTools();
    expect(first).toHaveLength(1);

    // Distinct instance on each call.
    expect(listModuleTools()).not.toBe(first);

    // Mutating the returned copy must not bleed into the registry.
    first.push(makeTool("zana_alpha_injected", "alpha"));
    first.pop();
    first.pop();
    expect(first).toHaveLength(0);

    const afterMutation = listModuleTools();
    expect(afterMutation).toHaveLength(1);
    expect(afterMutation[0].name).toBe("zana_alpha_a");
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

  // getModuleTool iterates registry.values() across ALL modules, not just the
  // first-registered one (tool-registry.ts line 50). Every other found-case
  // test registers a single module, so a regression that only searched the
  // first module would still pass. This pins the cross-module lookup: a tool
  // owned by a module registered AFTER another must still resolve, and to the
  // correct owning module.
  it("finds a tool belonging to a module registered after an earlier one", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_a", "alpha")]);
    registerModuleTools("beta", [makeTool("zana_beta_b", "beta")]);
    const found = getModuleTool("zana_beta_b");
    expect(found).not.toBeNull();
    expect(found.moduleId).toBe("beta");
    expect(found.name).toBe("zana_beta_b");
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
