/**
 * Unit tests for the team-lifecycle routing branches of agents/dispatch.ts.
 *
 * dispatch.ts is a command router; its job for these actions is to forward the
 * right arguments to team-runtime and surface the result unchanged. team-runtime
 * is a static `import`, so it mocks cleanly (unlike the swarm / modules-loader
 * branches, which dispatch reaches via runtime require()). These tests pin the
 * forwarding contract — especially that `start_team` threads the workspace
 * resolver through, which is easy to drop in a refactor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockStartTeam,
  mockStopTeam,
  mockSaveTeam,
  mockGetTeam,
  mockListRunningTeams,
} = vi.hoisted(() => ({
  mockStartTeam: vi.fn(),
  mockStopTeam: vi.fn(),
  mockSaveTeam: vi.fn(),
  mockGetTeam: vi.fn(),
  mockListRunningTeams: vi.fn(),
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
  listTeams: vi.fn(() => []),
  getTeam: mockGetTeam,
  startTeam: mockStartTeam,
  stopTeam: mockStopTeam,
  teamStatus: vi.fn(),
  listRunningTeams: mockListRunningTeams,
  saveTeam: mockSaveTeam,
  deleteTeam: vi.fn(),
}));

vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — team lifecycle routing", () => {
  it("start_team forwards the full payload AND the workspace resolver to startTeam", async () => {
    mockStartTeam.mockReturnValue({ teamId: "t1", status: "running" });
    const getWorkspaceFn = () => "/tmp/ws";
    const payload = { action: "start_team", teamId: "t1", config: { size: 3 } };

    const result = await handleOrchestratorCommand(payload, getWorkspaceFn);

    expect(result).toEqual({ teamId: "t1", status: "running" });
    // The router must pass the de-structured params (action stripped) plus the
    // SAME workspace resolver function — not call it, not drop it.
    const [paramsArg, fnArg] = mockStartTeam.mock.calls[0];
    expect(paramsArg).toEqual({ teamId: "t1", config: { size: 3 } });
    expect(paramsArg).not.toHaveProperty("action");
    expect(fnArg).toBe(getWorkspaceFn);
  });

  it("stop_team forwards only the teamId and returns the runtime result verbatim", async () => {
    mockStopTeam.mockReturnValue({ ok: true });
    const result = await handleOrchestratorCommand(
      { action: "stop_team", teamId: "t9", ignored: "x" },
      null,
    );
    expect(result).toEqual({ ok: true });
    expect(mockStopTeam).toHaveBeenCalledWith("t9");
  });

  it("save_team forwards the team object", async () => {
    const team = { id: "t2", name: "Strike" };
    mockSaveTeam.mockReturnValue({ ok: true, id: "t2" });
    const result = await handleOrchestratorCommand({ action: "save_team", team }, null);
    expect(result).toEqual({ ok: true, id: "t2" });
    expect(mockSaveTeam).toHaveBeenCalledWith(team);
  });

  it("list_running_teams surfaces the runtime list without reshaping it", async () => {
    mockListRunningTeams.mockReturnValue([{ teamId: "t1" }, { teamId: "t2" }]);
    const result = await handleOrchestratorCommand({ action: "list_running_teams" }, null);
    expect(result).toEqual([{ teamId: "t1" }, { teamId: "t2" }]);
  });
});
