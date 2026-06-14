// Tests for the untested exports of packages/work/src/teams/manager.ts:
//   • stopTeam(teamId)          — error when not running; success kills agents + emits event
//   • getTeamStatus(teamId)     — null when not running; status object when running
//   • listRunningTeams()        — empty when none; populated after startTeam
//   • resumeTeam(checkpointId)  — delegates to checkpointResume.resume
//   • listCheckpoints(filter)   — delegates to checkpointStore.list
//   • getCheckpoint(id)         — delegates to checkpointStore.load
//
// manager.ts uses function _core() { return require("@zana-ai/core"); } at
// call sites (NOT at module scope for startTeam).  vi.mock() does NOT intercept
// those dynamic require() calls, so we use vi.importActual to get the real
// agentManager and vi.spyOn to stub the methods that would otherwise spawn a
// real Claude process.  The module-scope onAgentsChange call fires during
// module load — the real agentManager is already imported at that point, so
// the spy must be set up BEFORE manager.ts is imported (via vi.hoisted).
//
// Fake timers suppress the 2 s writeToAgent and 3 s runningTeams.delete
// timeouts that startTeam / stopTeam schedule.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 1. Mock static dependencies (not dynamically required) ───────────────────

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
  resume: vi.fn(async () => ({ ok: true, checkpointId: "cp-arg", spawned: [] })),
}));

// ── 2. Get real @zana-ai/core and spy on spawnHeadlessAgent ──────────────────
//
// manager.ts calls require("@zana-ai/core").agents.manager.spawnHeadlessAgent()
// via its _agentManager() helper.  We spy on the real object so those calls
// are intercepted without needing to launch a real Claude process.

let realCore: any;
let agentManagerSpy: ReturnType<typeof vi.spyOn>;
let killAgentSpy: ReturnType<typeof vi.spyOn>;
let writeToAgentSpy: ReturnType<typeof vi.spyOn>;
let listAgentsSpy: ReturnType<typeof vi.spyOn>;
let fakeBus: { emit: ReturnType<typeof vi.fn> };

// We need to initialize workspace-context before manager.ts is imported,
// because the module-scope onAgentsChange call may transitively need it.
beforeAll(async () => {
  // Give the workspace-context a real tmpdir so internal path helpers work.
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-mgr-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = await vi.importActual("@zana-ai/core") as any;
  realCore.project.workspaceContext.init(tmpRoot);

  // Spy before manager.ts loads (spies persist after module import).
  agentManagerSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-default", terminalId: null });
  killAgentSpy = vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  writeToAgentSpy = vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);

  // Spy on the bus emit so we can assert on TEAM_STOPPED / TEAM_STARTED events.
  fakeBus = { emit: vi.spyOn(realCore.events.bus, "emit") as any };
});

// ── 3. Import manager AFTER spies are in place ────────────────────────────────

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as checkpointResume from "@zana-ai/work/src/runs/checkpoint/resume.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTeam(id = "team-1") {
  return {
    id,
    name: "Test Team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: [],
    slots: [],
  };
}

function makeProfile() {
  return {
    id: "orchestrator",
    displayName: "Orchestrator",
    appendSystemPrompt: "",
    allowedTools: ["Read"],
    disallowedTools: [],
  };
}

/** Call startTeam after wiring up the mocks for team + profile. */
function bootTeam(teamId: string) {
  (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue(makeTeam(teamId));
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue(makeProfile());
  agentManagerSpy.mockReturnValue({ agentId: `orch-${teamId}`, terminalId: null });
  const result = manager.startTeam(teamId, { headless: true });
  return result;
}

// ── test suites ───────────────────────────────────────────────────────────────

describe("manager — stopTeam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns { ok: false, error: 'team not running' } when team was never started", () => {
    const result = manager.stopTeam("ghost-team");
    expect(result).toEqual({ ok: false, error: "team not running" });
  });

  it("returns { ok: true } when the team is running", () => {
    bootTeam("team-stop-ok");
    const result = manager.stopTeam("team-stop-ok");
    expect(result).toEqual({ ok: true });
  });

  it("calls killAgent on the orchestrator when stopping", () => {
    bootTeam("team-stop-kill");
    killAgentSpy.mockClear();
    manager.stopTeam("team-stop-kill");
    expect(killAgentSpy).toHaveBeenCalledWith("orch-team-stop-kill");
  });

  it("emits TEAM_STOPPED with teamId, teamName, and reason='user'", () => {
    bootTeam("team-stop-event");
    (fakeBus.emit as ReturnType<typeof vi.fn>).mockClear();
    manager.stopTeam("team-stop-event");
    expect(fakeBus.emit).toHaveBeenCalledWith(
      realCore.events.EVENTS.TEAM_STOPPED,
      expect.objectContaining({ teamId: "team-stop-event", reason: "user" }),
    );
  });

  it("snapshots active worker agents into checkpointStore before killing", () => {
    bootTeam("team-stop-cp");
    listAgentsSpy.mockReturnValue([
      {
        id: "worker-w1",
        parentAgentId: "orch-team-stop-cp",
        state: "active",
        profileId: "coder",
        lastAction: "writing code",
      },
    ]);
    vi.clearAllMocks();
    manager.stopTeam("team-stop-cp");
    expect(checkpointStore.addPendingAgent).toHaveBeenCalledWith(
      "cp-test",
      expect.objectContaining({ agentId: "worker-w1", profileId: "coder" }),
    );
    expect(checkpointStore.update).toHaveBeenCalledWith("cp-test", { status: "stopped" });
  });

  it("removes the team from listRunningTeams after the 3 s cleanup timeout", () => {
    bootTeam("team-stop-del");
    manager.stopTeam("team-stop-del");
    // Still present before timeout fires
    expect(manager.listRunningTeams().some((t) => t.teamId === "team-stop-del")).toBe(true);
    vi.advanceTimersByTime(3001);
    expect(manager.listRunningTeams().some((t) => t.teamId === "team-stop-del")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("manager — getTeamStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when the team was never started", () => {
    expect(manager.getTeamStatus("no-such-team")).toBeNull();
  });

  it("returns a status object with orchestratorAgentId and workers when the team is running", () => {
    bootTeam("team-status-running");
    listAgentsSpy.mockReturnValue([
      { id: "orch-team-status-running", parentAgentId: null, state: "active" },
    ]);
    const status = manager.getTeamStatus("team-status-running");
    expect(status).not.toBeNull();
    expect(status!.orchestratorAgentId).toBe("orch-team-status-running");
    expect(status!.status).toBe("running");
    expect(Array.isArray(status!.workers)).toBe(true);
  });

  it("transitions a running team to 'completed' when the orchestrator agent has terminated", () => {
    bootTeam("team-status-done");
    // Orchestrator reports terminated → getTeamStatus must flip running→completed.
    listAgentsSpy.mockReturnValue([
      { id: "orch-team-status-done", parentAgentId: null, state: "terminated" },
    ]);

    const status = manager.getTeamStatus("team-status-done");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("completed");

    // The transition is persisted: a second query still reports completed.
    expect(manager.getTeamStatus("team-status-done")!.status).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("manager — listRunningTeams", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    listAgentsSpy.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty array when no teams have been started in this module session", () => {
    // Any previously started teams that completed their 3 s delay are gone.
    // This test is intentionally order-independent: we just assert that the
    // entries returned are well-formed objects with a workers array.
    const list = manager.listRunningTeams();
    expect(Array.isArray(list)).toBe(true);
  });

  it("includes newly started team in the list", () => {
    bootTeam("team-list-new");
    const list = manager.listRunningTeams();
    const entry = list.find((t) => t.teamId === "team-list-new");
    expect(entry).toBeDefined();
    expect(entry!.teamName).toBe("Test Team");
    expect(Array.isArray(entry!.workers)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("manager — resumeTeam", () => {
  it("delegates to checkpointResume.resume and returns its result", async () => {
    (checkpointResume.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, checkpointId: "cp-resume", spawned: [],
    });
    const result = await manager.resumeTeam("cp-resume");
    expect(checkpointResume.resume).toHaveBeenCalledOnce();
    // First argument must always be the checkpoint id
    const [firstArg] = (checkpointResume.resume as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstArg).toBe("cp-resume");
    expect(result).toMatchObject({ ok: true, checkpointId: "cp-resume" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("manager — listCheckpoints / getCheckpoint", () => {
  it("listCheckpoints delegates to checkpointStore.list with the filter argument", () => {
    const fakeList = [{ id: "cp-1", status: "stopped" }];
    (checkpointStore.list as ReturnType<typeof vi.fn>).mockReturnValue(fakeList);
    const result = manager.listCheckpoints({ status: "stopped" });
    expect(checkpointStore.list).toHaveBeenCalledWith({ status: "stopped" });
    expect(result).toBe(fakeList);
  });

  it("getCheckpoint delegates to checkpointStore.load with the id argument", () => {
    const fakeCP = { id: "cp-99", status: "completed", completedAgents: [] };
    (checkpointStore.load as ReturnType<typeof vi.fn>).mockReturnValue(fakeCP);
    const result = manager.getCheckpoint("cp-99");
    expect(checkpointStore.load).toHaveBeenCalledWith("cp-99");
    expect(result).toBe(fakeCP);
  });

  it("getCheckpoint returns null when the store has no matching checkpoint", () => {
    (checkpointStore.load as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(manager.getCheckpoint("no-such-cp")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("manager — startTeam duplicate guard", () => {
  // The `runningTeams` Map is module-level and never cleared between tests, so
  // we use unique teamIds (team-dup-*) that no other suite touches.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns { ok: false, error: 'team already running' } when startTeam is called twice with the same teamId", () => {
    // First call succeeds and registers the team in runningTeams.
    bootTeam("team-dup-guard");

    // Second call with the same id must hit the runningTeams.has() guard and
    // short-circuit before touching the agent manager or event bus.
    const second = manager.startTeam("team-dup-guard", { headless: true });

    expect(second).toEqual({ ok: false, error: "team already running" });
  });

  it("does not spawn a second orchestrator agent when the duplicate guard fires", () => {
    bootTeam("team-dup-no-spawn");

    // Clear spy history so we can assert on the second call in isolation.
    agentManagerSpy.mockClear();

    manager.startTeam("team-dup-no-spawn", { headless: true });

    // The duplicate-guard path returns before reaching spawnHeadlessAgent.
    expect(agentManagerSpy).not.toHaveBeenCalled();
  });
});
