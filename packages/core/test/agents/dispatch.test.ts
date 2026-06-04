/**
 * Unit tests for agents/dispatch.ts — handleOrchestratorCommand routing.
 *
 * Strategy: mock every side-effectful dependency so no real spawning, PTY,
 * filesystem, or network occurs. Each test exercises one branch of the big
 * switch and verifies the return shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock references (must precede vi.mock factory calls) ─────────────
const {
  mockListAgents,
  mockGetAgent,
  mockKillAgent,
  mockCheckSystemResources,
  mockRecordSpawnOverload,
  mockClearSpawnOverloadStreak,
  mockGetSpawnThrottleStreakLimit,
  mockGetMaxConcurrentAgents,
  mockSpawnHeadlessAgent,
  mockGetProfile,
  mockListProfiles,
} = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockGetAgent: vi.fn(),
  mockKillAgent: vi.fn(),
  mockCheckSystemResources: vi.fn(),
  mockRecordSpawnOverload: vi.fn(),
  mockClearSpawnOverloadStreak: vi.fn(),
  mockGetSpawnThrottleStreakLimit: vi.fn(),
  mockGetMaxConcurrentAgents: vi.fn(),
  mockSpawnHeadlessAgent: vi.fn(),
  mockGetProfile: vi.fn(),
  mockListProfiles: vi.fn(),
}));

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  listAgents: mockListAgents,
  getAgent: mockGetAgent,
  killAgent: mockKillAgent,
  checkSystemResources: mockCheckSystemResources,
  recordSpawnOverload: mockRecordSpawnOverload,
  clearSpawnOverloadStreak: mockClearSpawnOverloadStreak,
  getSpawnThrottleStreakLimit: mockGetSpawnThrottleStreakLimit,
  getMaxConcurrentAgents: mockGetMaxConcurrentAgents,
  spawnHeadlessAgent: mockSpawnHeadlessAgent,
}));

vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({
  getProfile: mockGetProfile,
  listProfiles: mockListProfiles,
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  listTeams: vi.fn(() => []),
  getTeam: vi.fn(),
  startTeam: vi.fn(),
  stopTeam: vi.fn(),
  teamStatus: vi.fn(),
  listRunningTeams: vi.fn(() => []),
  saveTeam: vi.fn(),
  deleteTeam: vi.fn(),
  checkpointSave: vi.fn(),
  checkpointList: vi.fn(),
  checkpointGet: vi.fn(),
  checkpointResume: vi.fn(),
}));

// @zana-ai/swarm is required at module load time — stub the whole package
vi.mock("@zana-ai/swarm", () => ({
  router: {
    generateMessageId: vi.fn(() => "msg-1"),
    drainInbox: vi.fn(() => []),
    publishToChannel: vi.fn(),
    subscribeChannel: vi.fn(),
    listChannels: vi.fn(() => []),
    getChannelHistory: vi.fn(() => []),
    sendAck: vi.fn(),
    routeMessage: vi.fn(),
    refreshRoutingTable: vi.fn(),
    discoverAgents: vi.fn(),
    requestAck: vi.fn(),
  },
  events: { pending: vi.fn(() => []) },
  spawner: {
    getSubDaemonPorts: vi.fn(() => []),
    listSubDaemons: vi.fn(() => []),
    spawnSubDaemon: vi.fn(),
    stopSubDaemon: vi.fn(),
    instructSubDaemon: vi.fn(),
  },
}));

vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

// modules/loader is require()'d dynamically inside spawn_agent — stub it
vi.mock("@zana-ai/core/src/modules/loader.ts", () => ({
  getModule: vi.fn(() => undefined),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSystemResources.mockReturnValue(null);
  mockGetMaxConcurrentAgents.mockReturnValue(10);
  mockGetSpawnThrottleStreakLimit.mockReturnValue(5);
  mockListAgents.mockReturnValue([]);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleOrchestratorCommand — unknown action", () => {
  it("returns an error for an unrecognised action string", async () => {
    const result = await call("does_not_exist");
    expect(result).toEqual({ error: "unknown action: does_not_exist" });
  });

  it("returns an error for empty string action", async () => {
    const result = await call("");
    expect(result).toEqual({ error: "unknown action: " });
  });
});

describe("handleOrchestratorCommand — list_agents", () => {
  it("returns empty array when no agents are running", async () => {
    mockListAgents.mockReturnValue([]);
    const result = await call("list_agents");
    expect(result).toEqual([]);
  });

  it("maps each agent to the public shape (id, profile, state, lastAction, mode)", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "a1",
        profileName: "Architect",
        state: "active",
        lastAction: "Running: Bash",
        mode: "headless",
        secretInternalField: "should-not-appear",
      },
    ]);
    const result = (await call("list_agents")) as any[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "a1",
      profile: "Architect",
      state: "active",
      lastAction: "Running: Bash",
      mode: "headless",
    });
    expect(result[0]).not.toHaveProperty("secretInternalField");
  });
});

describe("handleOrchestratorCommand — agent_status / agent_result", () => {
  it("agent_status: returns error when agent not found", async () => {
    mockGetAgent.mockReturnValue(null);
    const result = await call("agent_status", { agentId: "missing" });
    expect(result).toEqual({ error: "agent not found" });
  });

  it("agent_result: returns error when agent not found", async () => {
    mockGetAgent.mockReturnValue(null);
    const result = await call("agent_result", { agentId: "missing" });
    expect(result).toEqual({ error: "agent not found" });
  });

  it("agent_result: completed=true when state is terminated", async () => {
    mockGetAgent.mockReturnValue({ id: "a1", state: "terminated", result: "done" });
    const result = (await call("agent_result", { agentId: "a1" })) as any;
    expect(result.completed).toBe(true);
    expect(result.result).toBe("done");
  });

  it("agent_result: completed=false when state is active", async () => {
    mockGetAgent.mockReturnValue({ id: "a2", state: "active", result: null });
    const result = (await call("agent_result", { agentId: "a2" })) as any;
    expect(result.completed).toBe(false);
  });
});

describe("handleOrchestratorCommand — kill_agent", () => {
  it("delegates to killAgent and surfaces its boolean result", async () => {
    mockKillAgent.mockReturnValue(true);
    const result = await call("kill_agent", { agentId: "a1" });
    expect(result).toEqual({ ok: true });
    expect(mockKillAgent).toHaveBeenCalledWith("a1");
  });
});

describe("handleOrchestratorCommand — get_profile", () => {
  it("returns error when profile not found", async () => {
    mockGetProfile.mockReturnValue(undefined);
    const result = await call("get_profile", { profileId: "no-such-profile" });
    expect(result).toEqual({ error: "profile not found: no-such-profile" });
  });

  it("returns the profile object when it exists", async () => {
    const fakeProfile = { id: "p1", displayName: "Coder", model: "sonnet" };
    mockGetProfile.mockReturnValue(fakeProfile);
    const result = await call("get_profile", { profileId: "p1" });
    expect(result).toBe(fakeProfile);
  });
});

// spawn_agent_validated shares the same max-workers and profile-not-found
// guards as spawn_agent, but without the resilience-module dynamic require
// that runs first in spawn_agent. We test those guard conditions here.
describe("handleOrchestratorCommand — spawn_agent_validated guard conditions", () => {
  it("returns error when profile not found", async () => {
    mockGetProfile.mockReturnValue(undefined);
    const result = await call("spawn_agent_validated", {
      profileId: "missing",
      prompt: "hi",
    });
    expect((result as any).error).toMatch(/profile not found: missing/);
  });

  it("returns error when max concurrent workers is reached for a parent", async () => {
    mockGetMaxConcurrentAgents.mockReturnValue(2);
    mockListAgents.mockReturnValue([
      { parentAgentId: "parent-1", state: "active" },
      { parentAgentId: "parent-1", state: "active" },
    ]);
    const result = await call("spawn_agent_validated", {
      profileId: "p1",
      prompt: "hi",
      parentAgentId: "parent-1",
    });
    expect((result as any).error).toMatch(/max concurrent workers reached/);
  });

  it("does NOT enforce max-workers limit when there is no parentAgentId", async () => {
    mockGetMaxConcurrentAgents.mockReturnValue(1);
    // Two agents exist but none belong to the top-level caller
    mockListAgents.mockReturnValue([
      { parentAgentId: "other", state: "active" },
      { parentAgentId: "other", state: "active" },
    ]);
    mockGetProfile.mockReturnValue(undefined); // stops early with profile error
    const result = await call("spawn_agent_validated", { profileId: "x", prompt: "hi" });
    // Should NOT hit max-workers error — should hit profile-not-found instead
    expect((result as any).error).toMatch(/profile not found/);
    expect((result as any).error).not.toMatch(/max concurrent/);
  });
});
