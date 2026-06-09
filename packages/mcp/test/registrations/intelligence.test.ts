// Unit tests for registrations/intelligence.ts
//
// Covers:
//   - Tool definitions: eight tools with correct names and required fields
//   - getDaemon-based handlers: fake daemon passed in context, verify
//     the handler calls the right method with the right arguments
//     (zana_route_task, zana_memory_store, zana_memory_search,
//      zana_plan_create, zana_workers_list)
//
// NOTE: zana_module_config_{list,get,set} delegate to
// _moduleConfig() = require("@zana-ai/core").modules.config at call
// time.  The ssr.noExternal Vite config inlines @zana-ai/* before
// vi.mock can intercept them, so those handler internals are omitted
// — tool-definition shape is still verified.
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { intelligence } from "../../src/registrations/intelligence.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

function getHandler(name: string): Handler {
  return (intelligence.handlers as Record<string, Handler>)[name];
}

/** Build a fake daemon whose methods record every call. */
function makeDaemon() {
  const calls: Array<{ module: string; method: string; args: unknown[] }> = [];

  const record =
    (module: string, method: string) =>
    (...args: unknown[]) => {
      calls.push({ module, method, args });
      return Promise.resolve(`${module}.${method}-result`);
    };

  const daemon = {
    taskRouter: { route: record("taskRouter", "route") },
    vectorMemory: {
      store: record("vectorMemory", "store"),
      search: record("vectorMemory", "search"),
    },
    goapPlanner: { createPlan: record("goapPlanner", "createPlan") },
    backgroundWorkers: { list: record("backgroundWorkers", "list") },
  };

  return { daemon, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-definition shape
// ─────────────────────────────────────────────────────────────────────────────

describe("intelligence tool definitions", () => {
  const toolNames = intelligence.tools.map((t) => t.name);

  it("exposes exactly eight tool names", () => {
    expect(toolNames).toHaveLength(8);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_route_task",
        "zana_memory_store",
        "zana_memory_search",
        "zana_plan_create",
        "zana_workers_list",
        "zana_module_config_list",
        "zana_module_config_get",
        "zana_module_config_set",
      ]),
    );
  });

  it("zana_route_task requires prompt", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_route_task")!;
    expect(def.inputSchema.required).toContain("prompt");
  });

  it("zana_memory_store requires content", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_memory_store")!;
    expect(def.inputSchema.required).toContain("content");
  });

  it("zana_memory_search requires query", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_memory_search")!;
    expect(def.inputSchema.required).toContain("query");
  });

  it("zana_plan_create requires goal", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_plan_create")!;
    expect(def.inputSchema.required).toContain("goal");
  });

  it("zana_module_config_get requires moduleId", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_module_config_get")!;
    expect(def.inputSchema.required).toContain("moduleId");
  });

  it("zana_module_config_set requires moduleId, key, and value", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_module_config_set")!;
    expect(def.inputSchema.required).toEqual(
      expect.arrayContaining(["moduleId", "key", "value"]),
    );
  });

  it("zana_workers_list accepts no required inputs", () => {
    const def = intelligence.tools.find((t) => t.name === "zana_workers_list")!;
    expect(def.inputSchema.required ?? []).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_route_task
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_route_task handler", () => {
  it("calls taskRouter.route with a ticket built from prompt and context", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_route_task");
    await handler(
      { prompt: "build a login page", context: "web project" },
      { getDaemon: () => daemon },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      module: "taskRouter",
      method: "route",
    });
    const ticket = calls[0].args[0] as Record<string, unknown>;
    expect(ticket.title).toBe("build a login page");
    expect(ticket.description).toBe("web project");
    expect(ticket.labels).toEqual([]);
  });

  it("defaults description to empty string when context is omitted", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_route_task");
    await handler({ prompt: "just the prompt" }, { getDaemon: () => daemon });
    const ticket = calls[0].args[0] as Record<string, unknown>;
    expect(ticket.description).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_memory_store
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_memory_store handler", () => {
  it("calls vectorMemory.store with content and tags merged into metadata", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_store");
    await handler(
      { content: "The sky is blue", tags: ["nature", "color"], metadata: { source: "test" } },
      { getDaemon: () => daemon },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].module).toBe("vectorMemory");
    expect(calls[0].method).toBe("store");
    const payload = calls[0].args[0] as Record<string, unknown>;
    expect(payload.content).toBe("The sky is blue");
    const meta = payload.metadata as Record<string, unknown>;
    expect(meta.tags).toEqual(["nature", "color"]);
    expect(meta.source).toBe("test");
  });

  it("defaults tags to [] when omitted", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_store");
    await handler({ content: "no tags here" }, { getDaemon: () => daemon });
    const payload = calls[0].args[0] as Record<string, unknown>;
    const meta = payload.metadata as Record<string, unknown>;
    expect(meta.tags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_memory_search
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_memory_search handler", () => {
  it("calls vectorMemory.search forwarding query", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_search");
    await handler({ query: "sky color" }, { getDaemon: () => daemon });
    expect(calls[0].module).toBe("vectorMemory");
    expect(calls[0].method).toBe("search");
    expect(calls[0].args[0]).toBe("sky color");
  });

  it("defaults limit to 5 when not provided", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_search");
    await handler({ query: "q" }, { getDaemon: () => daemon });
    const opts = calls[0].args[1] as Record<string, unknown>;
    expect(opts.limit).toBe(5);
  });

  it("uses provided limit over the default", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_search");
    await handler({ query: "q", limit: 10 }, { getDaemon: () => daemon });
    const opts = calls[0].args[1] as Record<string, unknown>;
    expect(opts.limit).toBe(10);
  });

  it("defaults tags to [] when omitted", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_memory_search");
    await handler({ query: "q" }, { getDaemon: () => daemon });
    const opts = calls[0].args[1] as Record<string, unknown>;
    expect(opts.tags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_plan_create
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_plan_create handler", () => {
  it("calls goapPlanner.createPlan with the goal", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_plan_create");
    await handler({ goal: "deploy to production" }, { getDaemon: () => daemon });
    expect(calls[0].module).toBe("goapPlanner");
    expect(calls[0].method).toBe("createPlan");
    expect(calls[0].args[0]).toBe("deploy to production");
  });

  it("forwards constraints when provided", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_plan_create");
    await handler(
      { goal: "refactor auth", constraints: ["no downtime", "keep API stable"] },
      { getDaemon: () => daemon },
    );
    const options = calls[0].args[1] as Record<string, unknown>;
    expect(options.constraints).toEqual(["no downtime", "keep API stable"]);
  });

  it("maps currentState to initialState in the options object", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_plan_create");
    const state = { deploysBlocked: false };
    await handler(
      { goal: "ship it", currentState: state },
      { getDaemon: () => daemon },
    );
    const options = calls[0].args[1] as Record<string, unknown>;
    expect(options.initialState).toEqual(state);
  });

  it("passes an empty options object when only goal is given", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_plan_create");
    await handler({ goal: "goal only" }, { getDaemon: () => daemon });
    const options = calls[0].args[1] as Record<string, unknown>;
    expect(Object.keys(options)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_workers_list
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_workers_list handler", () => {
  it("calls backgroundWorkers.list() and returns its result", async () => {
    const { daemon, calls } = makeDaemon();
    const handler = getHandler("zana_workers_list");
    const result = await handler({}, { getDaemon: () => daemon });
    expect(calls).toHaveLength(1);
    expect(calls[0].module).toBe("backgroundWorkers");
    expect(calls[0].method).toBe("list");
    expect(result).toBe("backgroundWorkers.list-result");
  });
});
