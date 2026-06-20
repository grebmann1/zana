// Tests the INTERACTIVE (non-headless) success path of startTeam in
// packages/work/src/teams/manager.ts (src lines 271-277, 295).
//
// Every existing startTeam test drives the headless branch (headless:true) or
// the interactive ERROR paths (team/profile not found). None exercises a
// successful interactive spawn, so the spawnInteractive call, the 20 s
// ptyHost.writeTerminal kickoff timer, and the returned terminalId were
// unverified. This file closes that gap.
//
// manager.ts resolves @zana-ai/core via require() (the _core() helpers), which
// vi.mock() does NOT intercept — so, like the other manager suites, we use the
// REAL core, init a throwaway workspace context, and spy on the real agent
// manager + ptyHost. The test env sets ZANA_HEADLESS=1, which would force the
// headless branch, so we clear it for the duration of the test and restore it
// afterward. Fake timers drive the 20 s kickoff timer deterministically; no
// real Claude process is spawned, no real clock.

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
  createFromTeam: vi.fn(() => ({ id: "cp-interactive" })),
  resume: vi.fn(() => ({ ok: true })),
}));

import * as teamStore from "@zana-ai/work/src/teams/store.ts";

let realCore: any;
let manager: typeof import("@zana-ai/work/src/teams/manager.ts");
let listAgentsSpy: ReturnType<typeof vi.spyOn>;
let spawnInteractiveSpy: ReturnType<typeof vi.spyOn>;
let spawnHeadlessSpy: ReturnType<typeof vi.spyOn>;
let writeTerminalSpy: ReturnType<typeof vi.spyOn>;
let emitSpy: ReturnType<typeof vi.spyOn>;
let savedHeadlessEnv: string | undefined;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-interactive-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnInteractiveSpy = vi
    .spyOn(realCore.agents.manager, "spawnInteractive")
    .mockReturnValue({ agentId: "orch-interactive", terminalId: "term-42" });
  spawnHeadlessSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-headless", terminalId: null });
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  listAgentsSpy = vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  writeTerminalSpy = vi.spyOn(realCore.agents.ptyHost, "writeTerminal").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue({
    id: "orchestrator", displayName: "Orch", appendSystemPrompt: "", allowedTools: ["Read"], disallowedTools: [],
  });
  emitSpy = vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);

  manager = await import("@zana-ai/work/src/teams/manager.ts");
  // Bootstrapping real @zana-ai/core pulls the core↔work↔extras require-cycle,
  // which can exceed the default 10 s hook timeout under parallel load.
}, 60000);

describe("manager — startTeam interactive (non-headless) success path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    savedHeadlessEnv = process.env.ZANA_HEADLESS;
    delete process.env.ZANA_HEADLESS; // the suite sets this; force the interactive branch
    listAgentsSpy.mockReturnValue([]);
    spawnInteractiveSpy.mockClear();
    spawnHeadlessSpy.mockClear();
    writeTerminalSpy.mockClear();
    emitSpy.mockClear();
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-interactive",
      name: "Interactive Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
    });
  });

  afterEach(() => {
    manager.stopTeam("team-interactive"); // clear module-level runningTeams entry
    vi.useRealTimers();
    if (savedHeadlessEnv === undefined) delete process.env.ZANA_HEADLESS;
    else process.env.ZANA_HEADLESS = savedHeadlessEnv;
  });

  it("spawns interactively and writes the kickoff to the terminal after the 20s timer", () => {
    const result: any = manager.startTeam("team-interactive", {
      headless: false,
      prompt: "Build the thing",
    });

    // Interactive branch was taken — never the headless one.
    expect(result.ok).toBe(true);
    expect(result.terminalId).toBe("term-42");
    expect(result.orchestratorAgentId).toBe("orch-interactive");
    expect(spawnInteractiveSpy).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessSpy).not.toHaveBeenCalled();

    // The kickoff is written to the PTY only AFTER the 20 s delay, not before.
    expect(writeTerminalSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    expect(writeTerminalSpy).toHaveBeenCalledWith("term-42", "Build the thing\n");

    // The team is registered as running and TEAM_STARTED was emitted.
    expect(manager.listRunningTeams().some((t) => t.teamId === "team-interactive")).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamId: "team-interactive", orchestratorAgentId: "orch-interactive" }),
    );
  });
});
