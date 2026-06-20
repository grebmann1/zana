// Tests the child-worker teardown branch of stopTeam in
// packages/work/src/teams/manager.ts (src lines ~434-438):
//
//   const children = allAgents.filter((a) => a.parentAgentId === orchestratorAgentId);
//   for (const child of children) { _agentManager().killAgent(child.id); }
//
// The existing manager-stop-query suite asserts killAgent is called on the
// ORCHESTRATOR, and that active workers are snapshotted via addPendingAgent,
// but it never asserts that the orchestrator's CHILD agents are themselves
// killed. Without that teardown, stopping a team would orphan its workers as
// live Claude processes. This file closes that gap.
//
// manager.ts reaches @zana-ai/core through a dynamic require() (_core()), which
// vi.mock() does not intercept, so we spy on the REAL core agentManager (as the
// sibling stop-query suite does). The checkpoint store/resume modules are static
// imports and ARE mocked. Fake timers suppress startTeam's 2s writeToAgent and
// stopTeam's 3s runningTeams.delete timers. No real Claude, no real clock.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  resume: vi.fn(async () => ({ ok: true })),
}));

let realCore: any;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let killAgentSpy: ReturnType<typeof vi.spyOn>;
let listAgentsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-stopkids-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  spawnSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-default", terminalId: null });
  killAgentSpy = vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);
}, 60000);

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

function bootTeam(teamId: string, orchId: string) {
  (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
    id: teamId, name: "Stop Kids Team", orchestratorProfileId: "orchestrator",
    workerProfileIds: [], slots: [],
  });
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue({
    id: "orchestrator", displayName: "Orch", appendSystemPrompt: "", allowedTools: ["Read"], disallowedTools: [],
  });
  spawnSpy.mockReturnValue({ agentId: orchId, terminalId: null });
  const res = manager.startTeam(teamId, { headless: true }) as any;
  expect(res.ok).toBe(true);
}

describe("manager — stopTeam kills child workers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the orchestrator AND every child worker, leaving no orphaned agents", () => {
    const orch = "orch-stopkids";
    bootTeam("team-stopkids", orch);

    // Snapshot: orchestrator plus two of its workers and one unrelated agent
    // belonging to a different orchestrator (must NOT be killed).
    listAgentsSpy.mockReturnValue([
      { id: orch, parentAgentId: null, state: "active" },
      { id: "w1", parentAgentId: orch, state: "active", profileId: "coder", lastAction: "x" },
      { id: "w2", parentAgentId: orch, state: "active", profileId: "tester", lastAction: "y" },
      { id: "stranger", parentAgentId: "some-other-orch", state: "active", profileId: "coder" },
    ]);
    killAgentSpy.mockClear();

    const result = manager.stopTeam("team-stopkids");

    expect(result).toEqual({ ok: true });
    expect(killAgentSpy).toHaveBeenCalledWith(orch);
    expect(killAgentSpy).toHaveBeenCalledWith("w1");
    expect(killAgentSpy).toHaveBeenCalledWith("w2");
    // The agent parented to a different orchestrator must be left untouched.
    expect(killAgentSpy).not.toHaveBeenCalledWith("stranger");
    // Orchestrator (1) + two workers (2) = exactly three kills.
    expect(killAgentSpy).toHaveBeenCalledTimes(3);
  });
});
