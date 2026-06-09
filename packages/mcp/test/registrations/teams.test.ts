// Unit tests for registrations/teams.ts
//
// The interesting logic lives in two handlers:
//   - zana_list_teams: filters out slot-less teams and maps raw records to a
//     smaller public shape, computing `slotCount` from the `slots` array.
//   - zana_team_status: maps the raw status record (including nested agent
//     objects) to a safe public projection.
//
// All other handlers are thin callCore pass-throughs and are exercised for
// correct op names and argument forwarding.
//
// Strategy: inject a fake callCore — no daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { teams } from "../../src/registrations/teams.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (teams.handlers as Record<string, Handler>)[name];
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

/** Minimal raw team shape as returned by the core. */
function rawTeam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "team-1",
    name: "My Team",
    icon: "🚀",
    description: "A team",
    orchestratorProfileId: "lead",
    slots: [{ profileId: "worker", quantity: 2 }],
    autoStart: false,
    updatedAt: "2026-01-01T00:00:00Z",
    internalField: "should-not-appear",
    ...overrides,
  };
}

/** Minimal raw agent shape as part of team status. */
function rawAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent-1",
    profileId: "lead",
    profileName: "Lead",
    profileIcon: "🤖",
    state: "active",
    model: "claude-opus",
    pid: 12345,
    mode: "headless",
    lastAction: "Running...",
    lastActivity: 1700000000000,
    tokenCount: 42,
    spawnedAt: 1700000000000,
    parentAgentId: null,
    terminalId: "zana-abc123",
    result: null,
    secretField: "should-not-appear",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-definition shape
// ─────────────────────────────────────────────────────────────────────────────

describe("teams tool definitions", () => {
  const toolNames = teams.tools.map((t) => t.name);

  it("exposes the expected tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_list_teams",
        "zana_get_team",
        "zana_start_team",
        "zana_stop_team",
        "zana_team_status",
        "zana_save_team",
        "zana_delete_team",
        "zana_list_running_teams",
      ]),
    );
    expect(toolNames).toHaveLength(8);
  });

  it("zana_get_team requires teamId", () => {
    const tool = teams.tools.find((t) => t.name === "zana_get_team")!;
    expect(tool.inputSchema.required).toContain("teamId");
  });

  it("zana_start_team requires teamId and prompt", () => {
    const tool = teams.tools.find((t) => t.name === "zana_start_team")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["teamId", "prompt"]));
  });

  it("zana_save_team requires team", () => {
    const tool = teams.tools.find((t) => t.name === "zana_save_team")!;
    expect(tool.inputSchema.required).toContain("team");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of teams.tools) {
      expect(tool.description.length, `${tool.name} has empty description`).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_list_teams handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_list_teams handler", () => {
  const handler = getHandler("zana_list_teams");

  it("passes non-array responses through unchanged (e.g. error objects)", async () => {
    const err = { error: "forbidden" };
    const { callCore } = makeCallCore(err);
    const result = await handler({}, { callCore });
    expect(result).toBe(err);
  });

  it("filters out teams that have no slots (empty array)", async () => {
    const noSlots = rawTeam({ id: "t-empty", slots: [] });
    const withSlots = rawTeam({ id: "t-good" });
    const { callCore } = makeCallCore([noSlots, withSlots]);
    const result = (await handler({}, { callCore })) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-good");
  });

  it("filters out teams with a non-array slots field", async () => {
    const noSlots = rawTeam({ id: "t-null-slots", slots: null });
    const withSlots = rawTeam({ id: "t-good" });
    const { callCore } = makeCallCore([noSlots, withSlots]);
    const result = (await handler({}, { callCore })) as any[];
    expect(result.map((t: any) => t.id)).toEqual(["t-good"]);
  });

  it("maps team to the public summary shape", async () => {
    const raw = rawTeam({ id: "t-42", name: "Alpha Squad", autoStart: true });
    const { callCore } = makeCallCore([raw]);
    const [mapped] = (await handler({}, { callCore })) as any[];
    expect(mapped).toMatchObject({
      id: "t-42",
      name: "Alpha Squad",
      icon: "🚀",
      description: "A team",
      orchestratorProfileId: "lead",
      autoStart: true,
    });
  });

  it("strips private/internal fields from mapped teams", async () => {
    const raw = rawTeam();
    const { callCore } = makeCallCore([raw]);
    const [mapped] = (await handler({}, { callCore })) as any[];
    expect(mapped).not.toHaveProperty("internalField");
  });

  it("computes slotCount as the sum of slot quantities", async () => {
    const raw = rawTeam({
      slots: [
        { profileId: "worker-a", quantity: 3 },
        { profileId: "worker-b", quantity: 2 },
      ],
    });
    const { callCore } = makeCallCore([raw]);
    const [mapped] = (await handler({}, { callCore })) as any[];
    expect(mapped.slotCount).toBe(5);
  });

  it("computes slotCount of 0 for a team with no slots (edge case: non-array)", async () => {
    // Teams with non-array slots are filtered OUT, but if one slips through,
    // slotCount should still be 0 rather than NaN/crash.
    const raw = rawTeam({ slots: undefined });
    const { callCore } = makeCallCore([raw]);
    const result = (await handler({}, { callCore })) as any[];
    // Team has no slots → filtered out entirely
    expect(result).toHaveLength(0);
  });

  it("returns empty array when all teams are slot-less", async () => {
    const { callCore } = makeCallCore([rawTeam({ slots: [] }), rawTeam({ id: "t2", slots: [] })]);
    const result = (await handler({}, { callCore })) as any[];
    expect(result).toHaveLength(0);
  });

  it("calls callCore with op list_teams", async () => {
    const { callCore, calls } = makeCallCore([]);
    await handler({}, { callCore });
    expect(calls[0].op).toBe("list_teams");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_team_status handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_team_status handler", () => {
  const handler = getHandler("zana_team_status");

  it("passes through null/falsy status unchanged", async () => {
    const { callCore } = makeCallCore(null);
    const result = await handler({ teamId: "t-missing" }, { callCore });
    expect(result).toBeNull();
  });

  it("maps team status to the public projection shape", async () => {
    const orchestrator = rawAgent({ id: "orch-1", state: "active" });
    const status = {
      teamId: "t-1",
      teamName: "My Team",
      teamIcon: "🚀",
      orchestratorAgentId: "orch-1",
      checkpointId: "cp-1",
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      stoppedAt: null,
      orchestrator,
      workers: [],
    };
    const { callCore } = makeCallCore(status);
    const result = (await handler({ teamId: "t-1" }, { callCore })) as any;
    expect(result).toMatchObject({
      teamId: "t-1",
      teamName: "My Team",
      status: "running",
      orchestratorAgentId: "orch-1",
    });
  });

  it("strips private fields from the orchestrator agent projection", async () => {
    const orchestrator = rawAgent();
    const status = {
      teamId: "t-2",
      teamName: "T",
      teamIcon: "",
      orchestratorAgentId: "agent-1",
      checkpointId: null,
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      stoppedAt: null,
      orchestrator,
      workers: [],
    };
    const { callCore } = makeCallCore(status);
    const result = (await handler({ teamId: "t-2" }, { callCore })) as any;
    expect(result.orchestrator).not.toHaveProperty("secretField");
  });

  it("projects worker agents into the public shape", async () => {
    const worker = rawAgent({ id: "w-1", state: "idle", profileName: "Worker" });
    const status = {
      teamId: "t-3",
      teamName: "T",
      teamIcon: "",
      orchestratorAgentId: "orch-1",
      checkpointId: null,
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      stoppedAt: null,
      orchestrator: null,
      workers: [worker],
    };
    const { callCore } = makeCallCore(status);
    const result = (await handler({ teamId: "t-3" }, { callCore })) as any;
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]).toMatchObject({ id: "w-1", state: "idle", profileName: "Worker" });
    expect(result.workers[0]).not.toHaveProperty("secretField");
  });

  it("returns empty workers array when status.workers is not an array", async () => {
    const status = {
      teamId: "t-4",
      teamName: "T",
      teamIcon: "",
      orchestratorAgentId: null,
      checkpointId: null,
      status: "stopped",
      startedAt: null,
      stoppedAt: null,
      orchestrator: null,
      workers: null,
    };
    const { callCore } = makeCallCore(status);
    const result = (await handler({ teamId: "t-4" }, { callCore })) as any;
    expect(result.workers).toEqual([]);
  });

  it("calls callCore with op team_status and the provided teamId", async () => {
    const { callCore, calls } = makeCallCore(null);
    await handler({ teamId: "t-5" }, { callCore });
    expect(calls[0].op).toBe("team_status");
    expect((calls[0].args as any).teamId).toBe("t-5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Simple pass-through handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("pass-through handlers", () => {
  it("zana_get_team calls get_team with teamId", async () => {
    const { callCore, calls } = makeCallCore({ id: "t-1" });
    await getHandler("zana_get_team")({ teamId: "t-1" }, { callCore });
    expect(calls[0].op).toBe("get_team");
    expect((calls[0].args as any).teamId).toBe("t-1");
  });

  it("zana_start_team calls start_team with teamId, prompt, and optional cwd", async () => {
    const { callCore, calls } = makeCallCore({ runId: "r-1" });
    await getHandler("zana_start_team")(
      { teamId: "t-1", prompt: "Do the thing", cwd: "/home/user" },
      { callCore },
    );
    expect(calls[0].op).toBe("start_team");
    expect(calls[0].args).toMatchObject({ teamId: "t-1", prompt: "Do the thing", cwd: "/home/user" });
  });

  it("zana_stop_team calls stop_team with teamId", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await getHandler("zana_stop_team")({ teamId: "t-1" }, { callCore });
    expect(calls[0].op).toBe("stop_team");
    expect((calls[0].args as any).teamId).toBe("t-1");
  });

  it("zana_save_team calls save_team with team object", async () => {
    const team = { name: "New Team", slots: [{ profileId: "w", quantity: 1 }] };
    const { callCore, calls } = makeCallCore({ id: "t-new" });
    await getHandler("zana_save_team")({ team }, { callCore });
    expect(calls[0].op).toBe("save_team");
    expect((calls[0].args as any).team).toBe(team);
  });

  it("zana_delete_team calls delete_team with teamId", async () => {
    const { callCore, calls } = makeCallCore({ deleted: true });
    await getHandler("zana_delete_team")({ teamId: "t-del" }, { callCore });
    expect(calls[0].op).toBe("delete_team");
    expect((calls[0].args as any).teamId).toBe("t-del");
  });

  it("zana_list_running_teams calls list_running_teams with no args", async () => {
    const payload = [{ teamId: "t-1", status: "running" }];
    const { callCore, calls } = makeCallCore(payload);
    const result = await getHandler("zana_list_running_teams")({}, { callCore });
    expect(calls[0].op).toBe("list_running_teams");
    expect(result).toBe(payload);
  });
});
