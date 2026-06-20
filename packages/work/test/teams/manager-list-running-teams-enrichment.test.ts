// Tests the enrichment loop of listRunningTeams() in
// packages/work/src/teams/manager.ts (src lines 472-479):
//
//   return Array.from(runningTeams.values()).map((rt) => {
//     const orchestrator = allAgents.find((a) => a.id === rt.orchestratorAgentId);
//     const workers = allAgents.filter((a) => a.parentAgentId === rt.orchestratorAgentId);
//     return { ...rt, orchestrator: orchestrator || null, workers };
//   });
//
// The existing manager-stop-query suite only exercises listRunningTeams() with
// listAgents() stubbed to [] — so `orchestrator` is always null and `workers`
// always empty, and the find()/filter() join logic is never asserted for the
// POPULATED case. getTeamStatus() has its OWN, separate enrichment block that
// IS tested with live agents; listRunningTeams()'s map loop is independent and
// otherwise unverified. This file closes that gap.
//
// manager.ts resolves @zana-ai/core via a dynamic require() (the _core()
// helper), which vi.mock() does NOT intercept — so we spy on the REAL core and
// init a throwaway workspace context (same strategy as manager-stop-query).
// The checkpoint store/resume + team store are static imports, so vi.mock
// works for those. Fake timers suppress startTeam's 2 s writeToAgent timer and
// stopTeam's 3 s cleanup timer. No real Claude, no real clock.

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
  resume: vi.fn(() => ({ ok: true })),
}));

import * as teamStore from "@zana-ai/work/src/teams/store.ts";

let realCore: any;
let manager: typeof import("@zana-ai/work/src/teams/manager.ts");
let spawnSpy: ReturnType<typeof vi.spyOn>;
let listAgentsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-lrt-enrich-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "orch", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue({
    id: "orchestrator", displayName: "Orch", appendSystemPrompt: "", allowedTools: [], disallowedTools: [],
  });
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);

  // Import manager AFTER the onAgentsChange spy is installed.
  manager = await import("@zana-ai/work/src/teams/manager.ts");
  // Bootstrapping real @zana-ai/core pulls the core↔work↔extras require-cycle,
  // which can exceed the default 10 s hook timeout under parallel load.
}, 60000);

function bootTeam(teamId: string, orchId: string) {
  (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
    id: teamId, name: "Enrich Team", icon: "🧩",
    orchestratorProfileId: "orchestrator", workerProfileIds: [], slots: [],
  });
  spawnSpy.mockReturnValue({ agentId: orchId, terminalId: null });
  const res = manager.startTeam(teamId, { headless: true }) as any;
  expect(res.ok).toBe(true);
}

describe("manager — listRunningTeams enrichment (populated agent list)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // suppress startTeam's 2 s writeToAgent timer
    listAgentsSpy.mockReturnValue([]);
  });

  afterEach(() => {
    // stopTeam schedules a 3 s runningTeams.delete; advance so the next test
    // (and other suites) don't see a leftover "already running" team.
    try { manager.stopTeam("team-enrich"); vi.advanceTimersByTime(3001); } catch {}
    vi.useRealTimers();
  });

  it("matches the orchestrator by id and includes ONLY its own child workers", () => {
    const orch = "orch-enrich";
    bootTeam("team-enrich", orch);

    // Live snapshot: this team's orchestrator + two of its workers, plus an
    // unrelated agent parented to a DIFFERENT orchestrator (must be excluded).
    listAgentsSpy.mockReturnValue([
      { id: orch, parentAgentId: null, state: "active" },
      { id: "w1", parentAgentId: orch, state: "active", profileId: "coder" },
      { id: "w2", parentAgentId: orch, state: "active", profileId: "tester" },
      { id: "stranger", parentAgentId: "some-other-orch", state: "active", profileId: "coder" },
    ]);

    const entry = manager.listRunningTeams().find((t) => t.teamId === "team-enrich");
    expect(entry).toBeDefined();

    // orchestrator is the live agent matched by id (not null, not a stranger).
    expect(entry!.orchestrator).not.toBeNull();
    expect(entry!.orchestrator.id).toBe(orch);

    // workers are exactly the two children of THIS orchestrator — the stranger
    // parented elsewhere is filtered out.
    const workerIds = entry!.workers.map((w: any) => w.id).sort();
    expect(workerIds).toEqual(["w1", "w2"]);
    expect(entry!.workers.some((w: any) => w.id === "stranger")).toBe(false);
  });

  it("reports a null orchestrator when no live agent matches its id", () => {
    const orch = "orch-gone";
    bootTeam("team-enrich", orch);

    // The orchestrator agent is absent from the live list (e.g. already reaped).
    listAgentsSpy.mockReturnValue([
      { id: "unrelated", parentAgentId: "x", state: "active" },
    ]);

    const entry = manager.listRunningTeams().find((t) => t.teamId === "team-enrich");
    expect(entry).toBeDefined();
    expect(entry!.orchestrator).toBeNull();
    expect(entry!.workers).toEqual([]);
  });
});
