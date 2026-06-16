// Tests for the module-scope onAgentsChange auto-checkpoint listener in
// packages/work/src/teams/manager.ts (src lines 13-48).
//
// startTeam registers a checkpoint and an onAgentsChange callback. As workers
// finish, that callback must record each terminated/errored worker into the
// checkpoint exactly once (idempotent via the per-team `checkpointedAgents`
// Set), and when the orchestrator itself terminates the team must flip to
// "completed" and the checkpoint status updated. The existing suites mock
// addCompletedAgent but NEVER invoke the callback, so none of this behavior is
// asserted. This file closes that gap.
//
// manager.ts resolves @zana-ai/core via a dynamic `require()` (the _core()
// helper), which vi.mock() does NOT intercept — see manager-stop-query.test.ts.
// So we spy on the REAL core agentManager and capture the onAgentsChange
// callback it registers at module load, then invoke it directly with crafted
// listAgents() snapshots. The checkpoint store/resume modules ARE static
// imports, so vi.mock intercepts those. No real Claude, no real clock.

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
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";

let realCore: any;
let manager: typeof import("@zana-ai/work/src/teams/manager.ts");
let onAgentsChange: () => void;
let listAgentsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-ac-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  // Capture the onAgentsChange callback the moment manager.ts registers it.
  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation((cb: any) => {
    onAgentsChange = cb;
    return () => {};
  });
  vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "orch", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue({
    id: "orchestrator", displayName: "Orch", appendSystemPrompt: "", allowedTools: [], disallowedTools: [],
  });
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);

  // Import manager AFTER the onAgentsChange spy is installed so the captured
  // callback is our spy's argument, not a listener on the real manager.
  manager = await import("@zana-ai/work/src/teams/manager.ts");
  expect(typeof onAgentsChange).toBe("function");
  // Bootstrapping the real @zana-ai/core via importActual pulls in the
  // core↔work↔extras require-cycle and can exceed the default 10s hook
  // timeout when the full package suite runs many workers in parallel
  // (the import itself is cheap in isolation). Give it headroom so this
  // suite is deterministic under load rather than flaking on a slow import.
}, 60000);

/** Start a team with a unique id and a known orchestrator agent id. */
function bootTeam(teamId: string, orchId: string) {
  (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
    id: teamId, name: "AC Team", orchestratorProfileId: "orchestrator",
    workerProfileIds: [], slots: [],
  });
  (realCore.agents.manager.spawnHeadlessAgent as ReturnType<typeof vi.spyOn>).mockReturnValue({
    agentId: orchId, terminalId: null,
  });
  const res = manager.startTeam(teamId, { headless: true }) as any;
  expect(res.ok).toBe(true);
  return orchId;
}

describe("manager — onAgentsChange auto-checkpoint of finished workers", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // suppress startTeam's 2s writeToAgent timer
    (checkpointStore.addCompletedAgent as ReturnType<typeof vi.fn>).mockClear();
    (checkpointStore.update as ReturnType<typeof vi.fn>).mockClear();
    listAgentsSpy.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records each terminated/errored worker once, with exitCode 0 (terminated) and 1 (errored)", () => {
    const orch = bootTeam("team-ac-workers", "orch-ac-workers");
    listAgentsSpy.mockReturnValue([
      { id: orch, parentAgentId: null, state: "active" },
      { id: "w1", parentAgentId: orch, state: "terminated", profileId: "coder", profileName: "Coder", result: "shipped" },
      { id: "w2", parentAgentId: orch, state: "errored", profileId: "tester", profileName: "Tester", result: "" },
    ]);

    onAgentsChange();

    expect(checkpointStore.addCompletedAgent).toHaveBeenCalledWith("cp-test", {
      agentId: "w1", profileId: "coder", profileName: "Coder", result: "shipped", exitCode: 0,
    });
    expect(checkpointStore.addCompletedAgent).toHaveBeenCalledWith("cp-test", {
      agentId: "w2", profileId: "tester", profileName: "Tester", result: "", exitCode: 1,
    });
    vi.useRealTimers();
  });

  it("does not re-record a worker that was already checkpointed on a later change event", () => {
    const orch = bootTeam("team-ac-idem", "orch-ac-idem");
    listAgentsSpy.mockReturnValue([
      { id: orch, parentAgentId: null, state: "active" },
      { id: "wx", parentAgentId: orch, state: "terminated", profileId: "coder", profileName: "Coder", result: "ok" },
    ]);

    onAgentsChange(); // first sighting → recorded
    expect(checkpointStore.addCompletedAgent).toHaveBeenCalledTimes(1);

    (checkpointStore.addCompletedAgent as ReturnType<typeof vi.fn>).mockClear();
    onAgentsChange(); // same terminated worker → must be skipped
    expect(checkpointStore.addCompletedAgent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("flips the team to 'completed' and marks the checkpoint completed when the orchestrator terminates", () => {
    const orch = bootTeam("team-ac-orch", "orch-ac-orch");
    listAgentsSpy.mockReturnValue([{ id: orch, parentAgentId: null, state: "terminated" }]);

    onAgentsChange();

    expect(checkpointStore.update).toHaveBeenCalledWith("cp-test", { status: "completed" });
    expect(manager.getTeamStatus("team-ac-orch")!.status).toBe("completed");
    vi.useRealTimers();
  });

  it("skips agent-change events for teams that are no longer running", () => {
    const orch = bootTeam("team-ac-stopped", "orch-ac-stopped");
    listAgentsSpy.mockReturnValue([{ id: orch, parentAgentId: null, state: "terminated" }]);
    onAgentsChange();
    expect(manager.getTeamStatus("team-ac-stopped")!.status).toBe("completed");

    // A worker now appears terminated, but the team already left "running" —
    // the `rt.status !== "running"` guard must skip it (no new checkpoint write).
    (checkpointStore.addCompletedAgent as ReturnType<typeof vi.fn>).mockClear();
    listAgentsSpy.mockReturnValue([
      { id: orch, parentAgentId: null, state: "terminated" },
      { id: "late", parentAgentId: orch, state: "terminated", profileId: "coder" },
    ]);
    onAgentsChange();
    expect(checkpointStore.addCompletedAgent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
