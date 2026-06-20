// Tests notifyChange()'s listener error-isolation in
// packages/work/src/teams/manager.ts (src lines 74-79). A change listener that
// throws must NOT prevent the other registered listeners from receiving the
// snapshot — the `try { cb(snapshot); } catch {}` guard. The existing
// onTeamsChange suite only asserts the unsubscribe handle; it never drives
// notifyChange through a listener that throws. This file closes that gap.
//
// manager.ts resolves @zana-ai/core via a dynamic require() (the _core()
// helper), which vi.mock() does NOT intercept — so we use the REAL core, init
// a throwaway workspace context, and spy on the real agent manager. The
// checkpoint store/resume + team store are static imports, so vi.mock works
// for those. No real Claude, no real clock.

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
let listAgentsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-iso-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "orch", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue({
    id: "orchestrator", displayName: "Orch", appendSystemPrompt: "", allowedTools: [], disallowedTools: [],
  });
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);

  manager = await import("@zana-ai/work/src/teams/manager.ts");
  // Bootstrapping real @zana-ai/core pulls the core↔work↔extras require-cycle,
  // which can exceed the default 10s hook timeout under parallel load.
}, 60000);

describe("manager — notifyChange listener isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // suppress startTeam's 2s writeToAgent timer
    listAgentsSpy.mockReturnValue([]);
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-iso", name: "Isolation Team", orchestratorProfileId: "orchestrator",
      workerProfileIds: [], slots: [],
    });
    (realCore.agents.manager.spawnHeadlessAgent as ReturnType<typeof vi.spyOn>).mockReturnValue({
      agentId: "orch-iso", terminalId: null,
    });
  });

  afterEach(() => {
    manager.stopTeam("team-iso"); // clear the module-level runningTeams entry
    vi.useRealTimers();
  });

  it("still notifies a healthy listener when an earlier listener throws", () => {
    const thrower = vi.fn(() => { throw new Error("listener boom"); });
    const healthy = vi.fn();
    const unsubA = manager.onTeamsChange(thrower);
    const unsubB = manager.onTeamsChange(healthy);

    let result: any;
    expect(() => { result = manager.startTeam("team-iso", { headless: true }); }).not.toThrow();

    expect(result.ok).toBe(true);
    // The throwing listener was invoked but its error was swallowed...
    expect(thrower).toHaveBeenCalled();
    // ...and the healthy listener still received the running-teams snapshot.
    expect(healthy).toHaveBeenCalled();
    const snapshot = healthy.mock.calls[0][0];
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.some((t: any) => t.teamId === "team-iso")).toBe(true);

    unsubA();
    unsubB();
  });
});
