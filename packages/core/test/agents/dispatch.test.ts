/**
 * Unit tests for agents/dispatch.ts — handleOrchestratorCommand routing.
 *
 * Strategy: mock every side-effectful dependency so no real spawning, PTY,
 * filesystem, or network occurs. Each test exercises one branch of the big
 * switch and verifies the return shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

// dispatch.ts → spawn-cwd.ts → project/registry.ts reads config.ZANA_DIR at
// module load. The spawn_agent/_validated/_oneshot cases call resolveConfinedCwd,
// so stub the registry; the default (no cwd/projectId) path doesn't touch it.
vi.mock("@zana-ai/core/src/project/registry.ts", () => ({
  getById: vi.fn(() => null),
}));

// modules/loader is require()'d dynamically inside spawn_agent — stub it
vi.mock("@zana-ai/core/src/modules/loader.ts", () => ({
  getModule: vi.fn(() => undefined),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

// A call that supplies a real workspace via getWorkspaceFn, for cwd-confinement.
function callInWorkspace(action: string, params: Record<string, any>, workspace: string) {
  return handleOrchestratorCommand({ action, ...params }, () => workspace);
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

describe("handleOrchestratorCommand — list_profiles", () => {
  it("maps each profile to the public shape and drops internal fields", async () => {
    mockListProfiles.mockReturnValue([
      {
        id: "p1",
        displayName: "Coder",
        icon: "🤖",
        category: "engineering",
        description: "writes code",
        model: "sonnet",
        lens: "code-quality",
        systemPrompt: "secret internal prompt",
        mcpConfig: { should: "not appear" },
      },
    ]);
    const result = (await call("list_profiles")) as any[];
    expect(result).toEqual([
      {
        id: "p1",
        name: "Coder",
        icon: "🤖",
        category: "engineering",
        description: "writes code",
        model: "sonnet",
        // `lens` is exposed so callers can pick voters by concern (council auto-roster).
        lens: "code-quality",
      },
    ]);
    // Internal/sensitive fields must not leak through the public mapping.
    expect(result[0]).not.toHaveProperty("systemPrompt");
    expect(result[0]).not.toHaveProperty("mcpConfig");
  });

  it("exposes lens: null for a profile without a lens (coordination/util profiles)", async () => {
    mockListProfiles.mockReturnValue([
      { id: "orchestrator", displayName: "Orchestrator", model: "opus" },
    ]);
    const result = (await call("list_profiles")) as any[];
    expect(result[0].lens).toBeNull();
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

describe("handleOrchestratorCommand — resolve_agent_name", () => {
  // These two branches resolve entirely from the local agent registry and
  // return BEFORE any cross-daemon (swarm) lookup, so they stay deterministic
  // without driving the swarm router.
  it("returns null when no name is provided", async () => {
    const result = await call("resolve_agent_name", {});
    expect(result).toBeNull();
    // No name => must not even consult the local registry.
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("returns the local agent id on an exact name match", async () => {
    mockListAgents.mockReturnValue([
      { id: "agent-a", name: "Alice" },
      { id: "agent-b", name: "Bob" },
    ]);
    // An exact local-name hit short-circuits and returns the matching id.
    const result = await call("resolve_agent_name", { name: "Bob" });
    expect(result).toBe("agent-b");
  });
});

// spawn_agent / _validated / _oneshot now confine the worker's cwd to the
// workspace (or a registered projectId) via resolveConfinedCwd. These tests
// prove the WIRING — that the dispatch case rejects an escape and never reaches
// the spawn. spawn-cwd.test.ts covers the accept/confine rule itself.
//
// We drive this through spawn_agent_validated (not spawn_agent): both reach
// resolveConfinedCwd identically, but spawn_agent's leading
// `require("../modules/loader")` resilience hook isn't resolvable in this
// source-mode harness (see the spawn_agent_validated guard tests above, which
// exist for the same reason). The confinement check runs BEFORE validated's own
// `require("../guardrails/index")`, so a refusal returns cleanly without it.
describe("handleOrchestratorCommand — spawn cwd confinement (wiring)", () => {
  let workspace: string;
  let outside: string;
  beforeEach(() => {
    workspace = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "disp-ws-")));
    outside = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "disp-out-")));
    mockGetProfile.mockReturnValue({ id: "p1", displayName: "Coder" });
  });
  afterEach(() => {
    for (const d of [workspace, outside]) { try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("REFUSES a cwd outside the workspace and does NOT spawn", async () => {
    const r = await callInWorkspace(
      "spawn_agent_validated",
      { profileId: "p1", prompt: "hi", guardrails: [], cwd: outside },
      workspace,
    );
    expect((r as any).error).toMatch(/must be within the workspace/);
    expect(mockSpawnHeadlessAgent).not.toHaveBeenCalled();
  });

  it("REFUSES an unknown projectId and does NOT spawn", async () => {
    const r = await callInWorkspace(
      "spawn_agent_validated",
      { profileId: "p1", prompt: "hi", guardrails: [], projectId: "proj_nope" },
      workspace,
    );
    expect((r as any).error).toMatch(/unknown projectId/);
    expect(mockSpawnHeadlessAgent).not.toHaveBeenCalled();
  });

  it("REFUSES a symlink cwd that escapes the workspace and does NOT spawn", async () => {
    const link = nodePath.join(workspace, "escape-link");
    nodeFs.symlinkSync(outside, link);
    const r = await callInWorkspace(
      "spawn_agent_validated",
      { profileId: "p1", prompt: "hi", guardrails: [], cwd: link },
      workspace,
    );
    expect((r as any).error).toMatch(/must be within the workspace/);
    expect(mockSpawnHeadlessAgent).not.toHaveBeenCalled();
  });
});
