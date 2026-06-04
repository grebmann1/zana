/**
 * Unit tests for agents/team-runtime.ts
 *
 * Strategy: mock the lazyRequire utility so that team-runtime receives a
 * fully-controlled @zana-ai/work stub (the proxy's runtime require() bypasses
 * Vite's module graph, so mocking the package directly doesn't work).
 * Also mock lifecycle and profile-store. No real spawning, FS, or network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock references ──────────────────────────────────────────────────
const {
  mockCheckSystemResources,
  mockSpawnHeadlessAgent,
  mockGetAgent,
  // teams.store
  mockListTeams,
  mockGetTeam,
  mockSaveTeam,
  mockDeleteTeam,
  // teams.manager
  mockStartTeam,
  mockStopTeam,
  mockGetTeamStatus,
  mockListRunningTeams,
  // checkpoint store
  mockCpSave,
  mockCpList,
  mockCpLoad,
  // checkpoint resume
  mockCpResume,
} = vi.hoisted(() => ({
  mockCheckSystemResources: vi.fn(),
  mockSpawnHeadlessAgent: vi.fn(),
  mockGetAgent: vi.fn(),
  mockListTeams: vi.fn(),
  mockGetTeam: vi.fn(),
  mockSaveTeam: vi.fn(),
  mockDeleteTeam: vi.fn(),
  mockStartTeam: vi.fn(),
  mockStopTeam: vi.fn(),
  mockGetTeamStatus: vi.fn(),
  mockListRunningTeams: vi.fn(),
  mockCpSave: vi.fn(),
  mockCpList: vi.fn(),
  mockCpLoad: vi.fn(),
  mockCpResume: vi.fn(),
}));

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  checkSystemResources: mockCheckSystemResources,
  spawnHeadlessAgent: mockSpawnHeadlessAgent,
  getAgent: mockGetAgent,
}));

vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({
  getProfile: vi.fn(),
  listProfiles: vi.fn(),
}));

// Mock lazyRequire so that team-runtime's `const work = lazyRequire("@zana-ai/work")`
// returns our controlled stub. (The proxy's runtime require() call bypasses
// Vite's module graph, so vi.mock("@zana-ai/work") has no effect here.)
vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: vi.fn((target: string | (() => unknown)) => {
    const id = typeof target === "string" ? target : "__getter__";
    if (id === "@zana-ai/work") {
      return {
        teams: {
          store: {
            listTeams: mockListTeams,
            getTeam: mockGetTeam,
            saveTeam: mockSaveTeam,
            deleteTeam: mockDeleteTeam,
          },
          manager: {
            startTeam: mockStartTeam,
            stopTeam: mockStopTeam,
            getTeamStatus: mockGetTeamStatus,
            listRunningTeams: mockListRunningTeams,
          },
        },
        runs: {
          checkpoint: {
            store: {
              save: mockCpSave,
              list: mockCpList,
              load: mockCpLoad,
            },
            resume: {
              resume: mockCpResume,
            },
          },
        },
      };
    }
    return {};
  }),
}));

// ── Import SUT after mocks are in place ──────────────────────────────────────
import {
  listTeams,
  getTeam,
  startTeam,
  stopTeam,
  teamStatus,
  listRunningTeams,
  saveTeam,
  deleteTeam,
  checkpointSave,
  checkpointList,
  checkpointGet,
  checkpointResume,
} from "@zana-ai/core/src/agents/team-runtime.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listTeams ────────────────────────────────────────────────────────────────

describe("listTeams", () => {
  it("delegates to teams.store.listTeams and returns the result", () => {
    const teams = [{ id: "t1", name: "alpha" }];
    mockListTeams.mockReturnValue(teams);
    expect(listTeams()).toBe(teams);
    expect(mockListTeams).toHaveBeenCalledOnce();
  });
});

// ── getTeam ──────────────────────────────────────────────────────────────────

describe("getTeam", () => {
  it("returns the team when found", () => {
    const team = { id: "t1", name: "alpha" };
    mockGetTeam.mockReturnValue(team);
    expect(getTeam("t1")).toBe(team);
  });

  it("returns an error object when team is not found", () => {
    mockGetTeam.mockReturnValue(undefined);
    expect(getTeam("missing")).toEqual({ error: "team not found: missing" });
  });
});

// ── startTeam ────────────────────────────────────────────────────────────────

describe("startTeam", () => {
  it("returns ok:false with error when hard resource limit is hit", () => {
    mockCheckSystemResources.mockReturnValue("too many agents");
    const result = startTeam({ teamId: "t1", cwd: "/tmp" });
    expect(result).toEqual({ ok: false, error: "cannot start team: too many agents" });
    expect(mockStartTeam).not.toHaveBeenCalled();
  });

  it("delegates to teams.manager.startTeam when resources are available", () => {
    mockCheckSystemResources.mockReturnValue(null);
    mockStartTeam.mockReturnValue({ ok: true, pid: 42 });
    const result = startTeam({ teamId: "t1", cwd: "/workspace", prompt: "go" });
    expect(mockStartTeam).toHaveBeenCalledWith("t1", {
      prompt: "go",
      cwd: "/workspace",
      headless: true,
    });
    expect(result).toEqual({ ok: true, pid: 42 });
  });

  it("uses getWorkspaceFn when no cwd is provided", () => {
    mockCheckSystemResources.mockReturnValue(null);
    mockStartTeam.mockReturnValue({ ok: true });
    startTeam({ teamId: "t1" }, () => "/from-fn");
    expect(mockStartTeam).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ cwd: "/from-fn" }),
    );
  });
});

// ── stopTeam ─────────────────────────────────────────────────────────────────

describe("stopTeam", () => {
  it("delegates to teams.manager.stopTeam", () => {
    mockStopTeam.mockReturnValue({ ok: true });
    expect(stopTeam("t1")).toEqual({ ok: true });
    expect(mockStopTeam).toHaveBeenCalledWith("t1");
  });
});

// ── teamStatus ───────────────────────────────────────────────────────────────

describe("teamStatus", () => {
  it("returns status when team is running", () => {
    const status = { running: true, pid: 99 };
    mockGetTeamStatus.mockReturnValue(status);
    expect(teamStatus("t1")).toBe(status);
  });

  it("returns an error object when team is not running", () => {
    mockGetTeamStatus.mockReturnValue(undefined);
    expect(teamStatus("gone")).toEqual({ error: "team not running: gone" });
  });
});

// ── listRunningTeams ─────────────────────────────────────────────────────────

describe("listRunningTeams", () => {
  it("delegates to teams.manager.listRunningTeams", () => {
    const running = [{ id: "t1" }];
    mockListRunningTeams.mockReturnValue(running);
    expect(listRunningTeams()).toBe(running);
  });
});

// ── saveTeam ─────────────────────────────────────────────────────────────────

describe("saveTeam", () => {
  it("returns ok:true with id and name from the saved team", () => {
    mockSaveTeam.mockReturnValue({ id: "t-abc", name: "my-team", extra: "ignored" });
    expect(saveTeam({ name: "my-team" })).toEqual({ ok: true, id: "t-abc", name: "my-team" });
  });
});

// ── deleteTeam ───────────────────────────────────────────────────────────────

describe("deleteTeam", () => {
  it("returns { ok: true } when deletion succeeds", () => {
    mockDeleteTeam.mockReturnValue(true);
    expect(deleteTeam("t1")).toEqual({ ok: true });
  });

  it("returns { ok: false } when team does not exist", () => {
    mockDeleteTeam.mockReturnValue(false);
    expect(deleteTeam("missing")).toEqual({ ok: false });
  });
});

// ── checkpointSave ───────────────────────────────────────────────────────────

describe("checkpointSave", () => {
  it("returns ok:true and checkpointId from the saved checkpoint", () => {
    mockCpSave.mockReturnValue({ id: "cp-1", state: {} });
    expect(checkpointSave({ agentId: "a1" })).toEqual({ ok: true, checkpointId: "cp-1" });
    expect(mockCpSave).toHaveBeenCalledWith({ agentId: "a1" });
  });
});

// ── checkpointList ───────────────────────────────────────────────────────────

describe("checkpointList", () => {
  it("delegates to checkpoint store list", () => {
    const items = [{ id: "cp-1" }];
    mockCpList.mockReturnValue(items);
    expect(checkpointList({ agentId: "a1" })).toBe(items);
  });
});

// ── checkpointGet ────────────────────────────────────────────────────────────

describe("checkpointGet", () => {
  it("returns the checkpoint when found", () => {
    const cp = { id: "cp-1", state: {} };
    mockCpLoad.mockReturnValue(cp);
    expect(checkpointGet("cp-1")).toBe(cp);
  });

  it("returns { error: 'checkpoint not found' } when not found", () => {
    mockCpLoad.mockReturnValue(undefined);
    expect(checkpointGet("nope")).toEqual({ error: "checkpoint not found" });
  });
});

// ── checkpointResume ─────────────────────────────────────────────────────────

describe("checkpointResume", () => {
  it("delegates to checkpoint resume with the correct helpers", async () => {
    mockCpResume.mockResolvedValue({ ok: true, agentId: "a2" });
    const result = await checkpointResume("cp-1");
    expect(mockCpResume).toHaveBeenCalledWith(
      "cp-1",
      expect.objectContaining({
        spawnHeadlessAgent: mockSpawnHeadlessAgent,
        getAgent: mockGetAgent,
      }),
      expect.anything(), // profileStore
    );
    expect(result).toEqual({ ok: true, agentId: "a2" });
  });
});
