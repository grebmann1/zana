// Unit tests for registrations/swarm.ts
//
// The key behaviors under test:
//   1. tools array is empty when ZANA_MASTER_MODE is not "true" (default install)
//   2. handlers object contains all 6 swarm handler keys
//   3. each handler delegates to callCore with the correct op and arguments
//
// Strategy: import the module directly; inject a fake callCore — no daemon,
// no network, no real swarm processes.

import { describe, it, expect, vi, afterEach } from "vitest";
import { swarm } from "../../src/registrations/swarm.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (swarm.handlers as Record<string, Handler>)[name];
}

interface Captured {
  op: string;
  args: unknown;
}

function makeCallCore(result: unknown = null) {
  const calls: Captured[] = [];
  const callCore = (op: string, args?: unknown) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };
  return { callCore, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool visibility — ZANA_MASTER_MODE gating
// ─────────────────────────────────────────────────────────────────────────────

describe("swarm tool visibility gating", () => {
  it("exposes zero tools when ZANA_MASTER_MODE is not set to 'true'", () => {
    // In the test runner ZANA_MASTER_MODE is absent/unset → tools must be empty
    // so swarm tools never appear in tools/list for a default Claude Code install.
    const val = process.env.ZANA_MASTER_MODE;
    if (val !== "true") {
      expect(swarm.tools).toHaveLength(0);
    }
  });

  it("exports a ToolDomain with both .tools and .handlers", () => {
    expect(swarm).toHaveProperty("tools");
    expect(swarm).toHaveProperty("handlers");
    expect(Array.isArray(swarm.tools)).toBe(true);
    expect(typeof swarm.handlers).toBe("object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool visibility — BOTH gates open (ZANA_MASTER_MODE + ZANA_SWARM_EXPERIMENTAL)
//
// Flags are read once at module load (see gating.ts), so to exercise the
// gate-open path we set both env vars, reset the module cache, and re-import a
// fresh copy. This covers the only branch swarm.ts has that the default
// (gate-closed) tests above cannot reach.
// ─────────────────────────────────────────────────────────────────────────────

describe("swarm tool visibility — both gates open", () => {
  const ENV_KEYS = ["ZANA_MASTER_MODE", "ZANA_SWARM_EXPERIMENTAL"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("surfaces all 6 swarm tools when MASTER_MODE and SWARM_EXPERIMENTAL are both set", async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ZANA_MASTER_MODE = "true";
    process.env.ZANA_SWARM_EXPERIMENTAL = "1";

    vi.resetModules();
    const fresh = await import("../../src/registrations/swarm.ts");

    expect(fresh.swarm.tools).toHaveLength(6);
    expect(fresh.swarm.tools.map((t) => t.name)).toEqual([
      "zana_swarm_spawn",
      "zana_swarm_list",
      "zana_swarm_instruct",
      "zana_swarm_stop",
      "zana_swarm_broadcast",
      "zana_swarm_poll_events",
    ]);
  });

  it("stays closed when only MASTER_MODE is set (SWARM_EXPERIMENTAL still off)", async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ZANA_MASTER_MODE = "true";
    delete process.env.ZANA_SWARM_EXPERIMENTAL;

    vi.resetModules();
    const fresh = await import("../../src/registrations/swarm.ts");

    expect(fresh.swarm.tools).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler registration
// ─────────────────────────────────────────────────────────────────────────────

describe("swarm handler registration", () => {
  const EXPECTED_HANDLERS = [
    "zana_swarm_spawn",
    "zana_swarm_list",
    "zana_swarm_instruct",
    "zana_swarm_stop",
    "zana_swarm_broadcast",
    "zana_swarm_poll_events",
  ];

  it("registers all 6 swarm handlers", () => {
    const keys = Object.keys(swarm.handlers);
    for (const name of EXPECTED_HANDLERS) {
      expect(keys, `missing handler '${name}'`).toContain(name);
    }
    expect(keys).toHaveLength(EXPECTED_HANDLERS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler — pass-through delegation
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_swarm_spawn handler", () => {
  it("calls swarm_spawn with teamId, workspace, and prompt", async () => {
    const { callCore, calls } = makeCallCore({ daemonId: "d-1" });
    await getHandler("zana_swarm_spawn")(
      { teamId: "team-1", workspace: "/home/user", prompt: "Run tests" },
      { callCore },
    );
    expect(calls[0].op).toBe("swarm_spawn");
    expect(calls[0].args).toMatchObject({
      teamId: "team-1",
      workspace: "/home/user",
      prompt: "Run tests",
    });
  });

  it("passes undefined teamId/workspace when omitted (optional args)", async () => {
    const { callCore, calls } = makeCallCore({ daemonId: "d-2" });
    await getHandler("zana_swarm_spawn")({ prompt: "Just run" }, { callCore });
    expect(calls[0].op).toBe("swarm_spawn");
    expect((calls[0].args as any).prompt).toBe("Just run");
    expect((calls[0].args as any).teamId).toBeUndefined();
    expect((calls[0].args as any).workspace).toBeUndefined();
  });
});

describe("zana_swarm_list handler", () => {
  it("calls swarm_list with no extra arguments", async () => {
    const payload = [{ daemonId: "d-1", status: "running" }];
    const { callCore, calls } = makeCallCore(payload);
    const result = await getHandler("zana_swarm_list")({}, { callCore });
    expect(calls[0].op).toBe("swarm_list");
    expect(result).toBe(payload);
  });
});

describe("zana_swarm_instruct handler", () => {
  it("calls swarm_instruct with daemonId and message", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await getHandler("zana_swarm_instruct")(
      { daemonId: "d-1", message: "Please do the thing" },
      { callCore },
    );
    expect(calls[0].op).toBe("swarm_instruct");
    expect(calls[0].args).toMatchObject({ daemonId: "d-1", message: "Please do the thing" });
  });
});

describe("zana_swarm_stop handler", () => {
  it("calls swarm_stop with daemonId", async () => {
    const { callCore, calls } = makeCallCore({ stopped: true });
    await getHandler("zana_swarm_stop")({ daemonId: "d-3" }, { callCore });
    expect(calls[0].op).toBe("swarm_stop");
    expect((calls[0].args as any).daemonId).toBe("d-3");
  });
});

describe("zana_swarm_broadcast handler", () => {
  it("calls swarm_broadcast with message", async () => {
    const { callCore, calls } = makeCallCore({ sent: 3 });
    await getHandler("zana_swarm_broadcast")({ message: "Alert all daemons" }, { callCore });
    expect(calls[0].op).toBe("swarm_broadcast");
    expect((calls[0].args as any).message).toBe("Alert all daemons");
  });
});

describe("zana_swarm_poll_events handler", () => {
  it("calls swarm_poll_events with the since timestamp", async () => {
    const events = [{ type: "progress", daemonId: "d-1" }];
    const { callCore, calls } = makeCallCore(events);
    const result = await getHandler("zana_swarm_poll_events")({ since: 1700000000000 }, { callCore });
    expect(calls[0].op).toBe("swarm_poll_events");
    expect((calls[0].args as any).since).toBe(1700000000000);
    expect(result).toBe(events);
  });

  it("passes undefined since when omitted (poll all events)", async () => {
    const { callCore, calls } = makeCallCore([]);
    await getHandler("zana_swarm_poll_events")({}, { callCore });
    expect(calls[0].op).toBe("swarm_poll_events");
    expect((calls[0].args as any).since).toBeUndefined();
  });
});
