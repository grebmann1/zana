// Unit tests for registrations/events.ts
//
// Interesting logic:
//   zana_event_emit  — injects `source` from ZANA_TERMINAL_ID (fallback "agent")
//   zana_event_query — defaults `limit` to 50 when not supplied
//
// Strategy: fake callCore, no network, no file I/O.

import { describe, it, expect, afterEach } from "vitest";
import { events } from "../../src/registrations/events.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (events.handlers as Record<string, Handler>)[name];
}

function spyCallCore(returnValue: unknown = null) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const callCore = (op: string, args?: unknown) => {
    calls.push({ op, args: args ?? undefined });
    return Promise.resolve(returnValue);
  };
  return { callCore, calls };
}

// ─── tool definitions ────────────────────────────────────────────────────────

describe("events tool definitions", () => {
  it("exposes exactly two tools: zana_event_emit and zana_event_query", () => {
    const names = events.tools.map((t) => t.name);
    expect(names).toEqual(["zana_event_emit", "zana_event_query"]);
  });

  it("zana_event_emit requires 'type'", () => {
    const def = events.tools.find((t) => t.name === "zana_event_emit")!;
    expect(def.inputSchema.required).toContain("type");
  });

  it("zana_event_query has no required fields", () => {
    const def = events.tools.find((t) => t.name === "zana_event_query")!;
    expect(def.inputSchema.required ?? []).toHaveLength(0);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of events.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── zana_event_emit: source injection ──────────────────────────────────────

describe("zana_event_emit handler", () => {
  const originalTerminalId = process.env.ZANA_TERMINAL_ID;

  afterEach(() => {
    if (originalTerminalId === undefined) delete process.env.ZANA_TERMINAL_ID;
    else process.env.ZANA_TERMINAL_ID = originalTerminalId;
  });

  it("uses ZANA_TERMINAL_ID as the source when set", async () => {
    process.env.ZANA_TERMINAL_ID = "terminal-42";
    const { callCore, calls } = spyCallCore({ ok: true });
    await getHandler("zana_event_emit")({ type: "progress" }, { callCore });
    expect(calls[0].op).toBe("event_emit");
    expect(calls[0].args).toMatchObject({ source: "terminal-42" });
  });

  it("falls back to 'agent' source when ZANA_TERMINAL_ID is absent", async () => {
    delete process.env.ZANA_TERMINAL_ID;
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_event_emit")({ type: "milestone" }, { callCore });
    expect(calls[0].args).toMatchObject({ source: "agent" });
  });

  it("forwards type, payload, and tags to event_emit", async () => {
    delete process.env.ZANA_TERMINAL_ID;
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_event_emit")(
      { type: "progress", payload: { pct: 50 }, tags: ["ci", "build"] },
      { callCore },
    );
    expect(calls[0].args).toMatchObject({
      type: "progress",
      payload: { pct: 50 },
      tags: ["ci", "build"],
    });
  });

  it("returns the value from callCore unchanged", async () => {
    const resp = { eventId: "ev-1" };
    const { callCore } = spyCallCore(resp);
    const result = await getHandler("zana_event_emit")({ type: "x" }, { callCore });
    expect(result).toBe(resp);
  });
});

// ─── zana_event_query: default limit ────────────────────────────────────────

describe("zana_event_query handler", () => {
  it("defaults limit to 50 when not supplied", async () => {
    const { callCore, calls } = spyCallCore([]);
    await getHandler("zana_event_query")({}, { callCore });
    expect(calls[0].op).toBe("event_query");
    expect(calls[0].args).toMatchObject({ limit: 50 });
  });

  it("uses caller-supplied limit when provided", async () => {
    const { callCore, calls } = spyCallCore([]);
    await getHandler("zana_event_query")({ limit: 10 }, { callCore });
    expect(calls[0].args).toMatchObject({ limit: 10 });
  });

  it("forwards types, source, and since filters", async () => {
    const { callCore, calls } = spyCallCore([]);
    await getHandler("zana_event_query")(
      { types: ["progress", "milestone"], source: "agent-7", since: 1717000000000, limit: 5 },
      { callCore },
    );
    expect(calls[0].args).toMatchObject({
      types: ["progress", "milestone"],
      source: "agent-7",
      since: 1717000000000,
      limit: 5,
    });
  });

  it("returns the value from callCore unchanged", async () => {
    const payload = [{ id: "ev-1", type: "milestone" }];
    const { callCore } = spyCallCore(payload);
    const result = await getHandler("zana_event_query")({}, { callCore });
    expect(result).toBe(payload);
  });
});
