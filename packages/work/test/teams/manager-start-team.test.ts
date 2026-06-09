// Tests for startTeam error paths and onTeamsChange listener management
// in packages/work/src/teams/manager.ts.
//
// manager.ts calls _agentManager().onAgentsChange(...) at module scope, so
// @zana-ai/core must be mocked BEFORE the module is imported.  vi.hoisted()
// puts the mock objects above the vi.mock() hoisting boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeAgentManager, fakeProfileStore, fakeBus } = vi.hoisted(() => {
  const fakeAgentManager = {
    onAgentsChange: vi.fn(),
    listAgents: vi.fn(() => []),
    spawnHeadlessAgent: vi.fn(() => ({ agentId: "orch-1", terminalId: null })),
    spawnInteractive: vi.fn(() => ({ agentId: "orch-2", terminalId: "t-1" })),
    killAgent: vi.fn(),
    writeToAgent: vi.fn(),
  };
  const fakeProfileStore = {
    getProfile: vi.fn(() => null),
    listProfiles: vi.fn(() => []),
  };
  const fakeBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
  return { fakeAgentManager, fakeProfileStore, fakeBus };
});

vi.mock("@zana-ai/core", () => ({
  agents: {
    manager: fakeAgentManager,
    profileStore: fakeProfileStore,
    ptyHost: { writeTerminal: vi.fn() },
  },
  events: {
    bus: fakeBus,
    EVENTS: { TEAM_STARTED: "team:started", TEAM_STOPPED: "team:stopped" },
  },
  config: { ZANA_DIR: "/tmp/zana-test", TEAMS_DIR: "/tmp/zana-test/teams" },
}));

vi.mock("@zana-ai/work/src/teams/store.ts", () => ({
  getTeam: vi.fn(() => null),
  saveTeam: vi.fn(),
  listTeams: vi.fn(() => []),
  deleteTeam: vi.fn(),
}));

vi.mock("@zana-ai/work/src/runs/checkpoint/store.ts", () => ({
  addCompletedAgent: vi.fn(),
  update: vi.fn(),
  addPendingAgent: vi.fn(),
  list: vi.fn(() => []),
  load: vi.fn(() => null),
}));

vi.mock("@zana-ai/work/src/runs/checkpoint/resume.ts", () => ({
  createFromTeam: vi.fn(() => ({ id: "cp-test" })),
  resume: vi.fn(() => ({ ok: true })),
}));

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-1",
    name: "Test Team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: [],
    slots: [],
    ...overrides,
  };
}

describe("manager — startTeam error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue(null);
    fakeProfileStore.getProfile.mockReturnValue(null);
  });

  it("returns { ok: false, error: 'team not found' } when team does not exist", () => {
    const result = manager.startTeam("nonexistent");
    expect(result).toEqual({ ok: false, error: "team not found" });
  });

  it("returns orchestrator-profile-not-found error when profile is missing", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTeam({ orchestratorProfileId: "missing-profile" }),
    );
    // getProfile already returns null by default
    const result = manager.startTeam("team-1");
    expect(result).toEqual({ ok: false, error: "orchestrator profile not found: missing-profile" });
  });

});

describe("manager — onTeamsChange listener", () => {
  it("returns an unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = manager.onTeamsChange(cb);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("does not throw when unsubscribe is called multiple times", () => {
    const cb = vi.fn();
    const unsub = manager.onTeamsChange(cb);
    expect(() => { unsub(); unsub(); }).not.toThrow();
  });
});
