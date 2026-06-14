/**
 * Unit tests for the team query/teardown routing branches of agents/dispatch.ts
 * that the sibling dispatch-team-routing.test.ts leaves uncovered:
 * list_teams, get_team, team_status, and delete_team.
 *
 * dispatch.ts is a command router; for these actions its only job is to forward
 * the right argument to team-runtime and surface the result unchanged. team-runtime
 * is a static `import`, so it mocks cleanly — no real spawning, PTY, or network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockListTeams,
  mockGetTeam,
  mockTeamStatus,
  mockDeleteTeam,
} = vi.hoisted(() => ({
  mockListTeams: vi.fn(),
  mockGetTeam: vi.fn(),
  mockTeamStatus: vi.fn(),
  mockDeleteTeam: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  killAgent: vi.fn(),
  checkSystemResources: vi.fn(() => null),
  recordSpawnOverload: vi.fn(),
  clearSpawnOverloadStreak: vi.fn(),
  getSpawnThrottleStreakLimit: vi.fn(() => 5),
  getMaxConcurrentAgents: vi.fn(() => 10),
  spawnHeadlessAgent: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({
  getProfile: vi.fn(),
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  listTeams: mockListTeams,
  getTeam: mockGetTeam,
  startTeam: vi.fn(),
  stopTeam: vi.fn(),
  teamStatus: mockTeamStatus,
  listRunningTeams: vi.fn(() => []),
  saveTeam: vi.fn(),
  deleteTeam: mockDeleteTeam,
}));

vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — team query/teardown routing", () => {
  it("list_teams surfaces the runtime's team list without reshaping it", async () => {
    mockListTeams.mockReturnValue([{ id: "t1" }, { id: "t2" }]);
    const result = await call("list_teams");
    expect(result).toEqual([{ id: "t1" }, { id: "t2" }]);
    // list_teams takes no params — must be called with none.
    expect(mockListTeams).toHaveBeenCalledWith();
  });

  it("get_team forwards only the teamId and returns the runtime result verbatim", async () => {
    const team = { id: "t1", name: "Strike", members: ["a", "b"] };
    mockGetTeam.mockReturnValue(team);
    const result = await call("get_team", { teamId: "t1", ignored: "x" });
    expect(result).toBe(team);
    expect(mockGetTeam).toHaveBeenCalledWith("t1");
  });

  it("team_status forwards the teamId to teamStatus", async () => {
    mockTeamStatus.mockReturnValue({ teamId: "t1", state: "running", agents: 3 });
    const result = await call("team_status", { teamId: "t1" });
    expect(result).toEqual({ teamId: "t1", state: "running", agents: 3 });
    expect(mockTeamStatus).toHaveBeenCalledWith("t1");
  });

  it("delete_team forwards the teamId and surfaces the runtime result verbatim", async () => {
    mockDeleteTeam.mockReturnValue({ ok: true });
    const result = await call("delete_team", { teamId: "t9" });
    expect(result).toEqual({ ok: true });
    expect(mockDeleteTeam).toHaveBeenCalledWith("t9");
  });
});
