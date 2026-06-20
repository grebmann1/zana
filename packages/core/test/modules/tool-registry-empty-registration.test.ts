// Focused coverage for the accept/reject boundary of registerModuleTools'
// guard: `if (!moduleId || !Array.isArray(tools)) return;`.
//
// tool-registry.test.ts covers the REJECT side (missing moduleId, null/non-array
// tools are silently ignored) and the overwrite of one non-empty list by
// another. It does NOT cover the valid EMPTY-ARRAY case, which lands on the
// accept side of the same guard: Array.isArray([]) is true, so an explicit
// zero-tool registration is STORED (a module that declares no MCP tools), and
// re-registering a module with [] therefore CLEARS its prior tools — in
// deliberate contrast to a non-array argument, which is ignored and leaves the
// previous tools intact. Pure in-memory module: deterministic, no I/O.

import { describe, it, expect, beforeEach } from "vitest";

const registry = require("@zana-ai/core/src/modules/tool-registry.ts");
const {
  registerModuleTools,
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

describe("registerModuleTools — valid empty-array registration", () => {
  it("accepts an empty array (passes the Array.isArray guard) and contributes no tools", () => {
    registerModuleTools("alpha", []);
    expect(listModuleTools()).toEqual([]);
    expect(getToolsForModule("alpha")).toEqual([]);
    expect(getModuleTool("zana_alpha_anything")).toBeNull();
  });

  it("re-registering with [] CLEARS a module's prior tools (unlike a non-array, which is ignored)", () => {
    registerModuleTools("alpha", [makeTool("zana_alpha_old", "alpha")]);
    expect(listModuleTools()).toHaveLength(1);

    // Empty array is accepted → overwrites the stored list with zero tools.
    registerModuleTools("alpha", []);
    expect(listModuleTools()).toEqual([]);
    expect(getModuleTool("zana_alpha_old")).toBeNull();

    // Contrast: a non-array argument is rejected by the guard and is a no-op,
    // so a prior registration would survive it.
    registerModuleTools("alpha", [makeTool("zana_alpha_new", "alpha")]);
    registerModuleTools("alpha", null as any);
    expect(listModuleTools().map((t: any) => t.name)).toEqual(["zana_alpha_new"]);
  });
});
