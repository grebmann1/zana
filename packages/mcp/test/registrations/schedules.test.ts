// Unit tests for registrations/schedules.ts
//
// The interesting logic lives in `zana_schedule_create`, which injects
// ownerId/ownerName from env vars (with fallbacks), and in several handlers
// that remap the public `scheduleId` field to the internal `id` field.
// All other handlers are thin callCore pass-throughs.
//
// Strategy: inject a fake callCore — no daemon, no network, no file I/O.
// Env vars are set/restored per-test so tests remain deterministic.

import { describe, it, expect, afterEach } from "vitest";
import { schedules } from "../../src/registrations/schedules.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (schedules.handlers as Record<string, Handler>)[name];
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

describe("schedules tool definitions", () => {
  it("exposes all nine tool names", () => {
    const names = schedules.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "zana_schedule_create",
        "zana_schedule_list",
        "zana_schedule_get",
        "zana_schedule_update",
        "zana_schedule_delete",
        "zana_schedule_enable",
        "zana_schedule_disable",
        "zana_schedule_trigger",
        "zana_schedule_reload",
      ]),
    );
    expect(schedules.tools).toHaveLength(9);
  });

  it("zana_schedule_create requires name and action", () => {
    const def = schedules.tools.find((t) => t.name === "zana_schedule_create")!;
    expect(def.inputSchema.required).toContain("name");
    expect(def.inputSchema.required).toContain("action");
  });

  it("zana_schedule_get requires scheduleId", () => {
    const def = schedules.tools.find((t) => t.name === "zana_schedule_get")!;
    expect(def.inputSchema.required).toContain("scheduleId");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of schedules.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── zana_schedule_create: env-var injection ─────────────────────────────────

describe("zana_schedule_create handler", () => {
  const originalTerminalId = process.env.ZANA_TERMINAL_ID;
  const originalAgentName = process.env.ZANA_AGENT_NAME;

  afterEach(() => {
    // restore env vars after each test
    if (originalTerminalId === undefined) delete process.env.ZANA_TERMINAL_ID;
    else process.env.ZANA_TERMINAL_ID = originalTerminalId;

    if (originalAgentName === undefined) delete process.env.ZANA_AGENT_NAME;
    else process.env.ZANA_AGENT_NAME = originalAgentName;
  });

  it("uses env vars ZANA_TERMINAL_ID and ZANA_AGENT_NAME when set", async () => {
    process.env.ZANA_TERMINAL_ID = "terminal-99";
    process.env.ZANA_AGENT_NAME = "TestAgent";

    const { callCore, calls } = spyCallCore({ id: "sched-1" });
    const action = { type: "prompt", prompt: "hello" };
    await getHandler("zana_schedule_create")({ name: "my-sched", action }, { callCore });

    expect(calls[0].op).toBe("schedule_create");
    expect(calls[0].args).toMatchObject({ ownerId: "terminal-99", ownerName: "TestAgent" });
  });

  it("falls back to 'agent' ownerId and 'Agent' ownerName when env vars are absent", async () => {
    delete process.env.ZANA_TERMINAL_ID;
    delete process.env.ZANA_AGENT_NAME;

    const { callCore, calls } = spyCallCore({ id: "sched-2" });
    const action = { type: "prompt", prompt: "hello" };
    await getHandler("zana_schedule_create")({ name: "my-sched", action }, { callCore });

    expect(calls[0].args).toMatchObject({ ownerId: "agent", ownerName: "Agent" });
  });

  it("forwards all schedule fields to schedule_create", async () => {
    delete process.env.ZANA_TERMINAL_ID;
    delete process.env.ZANA_AGENT_NAME;

    const { callCore, calls } = spyCallCore(null);
    const action = { type: "command", command: ["npm", "test"] };
    await getHandler("zana_schedule_create")(
      { name: "ci", description: "run tests", cron: "0 * * * *", every: "1h", intervalMs: 3600000, action, enabled: false },
      { callCore },
    );

    expect(calls[0].op).toBe("schedule_create");
    expect(calls[0].args).toMatchObject({
      name: "ci",
      description: "run tests",
      cron: "0 * * * *",
      every: "1h",
      intervalMs: 3600000,
      action,
      enabled: false,
    });
  });

  it("returns the value from callCore unchanged", async () => {
    const resp = { id: "sched-new" };
    const { callCore } = spyCallCore(resp);
    const result = await getHandler("zana_schedule_create")(
      { name: "s", action: { type: "prompt", prompt: "x" } },
      { callCore },
    );
    expect(result).toBe(resp);
  });
});

// ─── simple pass-through handlers ────────────────────────────────────────────

describe("zana_schedule_list handler", () => {
  it("calls schedule_list with no args and returns result", async () => {
    const payload = [{ id: "s1" }];
    const { callCore, calls } = spyCallCore(payload);
    const result = await getHandler("zana_schedule_list")({}, { callCore });
    expect(calls[0].op).toBe("schedule_list");
    expect(calls[0].args).toBeUndefined();
    expect(result).toBe(payload);
  });
});

describe("zana_schedule_get handler", () => {
  it("forwards scheduleId to schedule_get", async () => {
    const { callCore, calls } = spyCallCore({ id: "s1" });
    await getHandler("zana_schedule_get")({ scheduleId: "s1" }, { callCore });
    expect(calls[0].op).toBe("schedule_get");
    expect(calls[0].args).toEqual({ scheduleId: "s1" });
  });
});

describe("zana_schedule_update handler", () => {
  it("maps scheduleId to id in the payload sent to schedule_update", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_schedule_update")(
      { scheduleId: "s-upd", name: "new-name", cron: "*/5 * * * *", enabled: true },
      { callCore },
    );
    expect(calls[0].op).toBe("schedule_update");
    expect(calls[0].args).toMatchObject({ id: "s-upd", name: "new-name", cron: "*/5 * * * *", enabled: true });
    // scheduleId should not leak through
    expect((calls[0].args as Record<string, unknown>).scheduleId).toBeUndefined();
  });
});

describe("zana_schedule_delete handler", () => {
  it("maps scheduleId to id", async () => {
    const { callCore, calls } = spyCallCore({ ok: true });
    await getHandler("zana_schedule_delete")({ scheduleId: "s-del" }, { callCore });
    expect(calls[0].op).toBe("schedule_delete");
    expect(calls[0].args).toEqual({ id: "s-del" });
  });
});

describe("zana_schedule_enable handler", () => {
  it("maps scheduleId to id", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_schedule_enable")({ scheduleId: "s-en" }, { callCore });
    expect(calls[0].op).toBe("schedule_enable");
    expect(calls[0].args).toEqual({ id: "s-en" });
  });
});

describe("zana_schedule_disable handler", () => {
  it("maps scheduleId to id", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_schedule_disable")({ scheduleId: "s-dis" }, { callCore });
    expect(calls[0].op).toBe("schedule_disable");
    expect(calls[0].args).toEqual({ id: "s-dis" });
  });
});

describe("zana_schedule_trigger handler", () => {
  it("maps scheduleId to id", async () => {
    const { callCore, calls } = spyCallCore({ triggered: true });
    await getHandler("zana_schedule_trigger")({ scheduleId: "s-trig" }, { callCore });
    expect(calls[0].op).toBe("schedule_trigger");
    expect(calls[0].args).toEqual({ id: "s-trig" });
  });
});

describe("zana_schedule_reload handler", () => {
  it("calls schedule_reload with no args", async () => {
    const { callCore, calls } = spyCallCore({ reloaded: 3 });
    const result = await getHandler("zana_schedule_reload")({}, { callCore });
    expect(calls[0].op).toBe("schedule_reload");
    expect(calls[0].args).toBeUndefined();
    expect(result).toMatchObject({ reloaded: 3 });
  });
});
