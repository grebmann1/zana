// Resilience test for resolveExecutionStrategy's try/catch fallback in
// packages/work/src/teams/manager.ts (src lines 19-24).
//
// When a team does NOT pin its own executionStrategy, startTeam consults the
// global module config (_moduleConfig().get()?.system.executionStrategy). If
// reading that config THROWS, resolveExecutionStrategy must swallow the error
// and fall back to the "process" strategy so the team still starts — rather
// than letting the exception escape and crash startTeam. Every other suite
// mocks moduleConfig.get() to return a value, so this catch branch is
// otherwise unexercised.
//
// manager.ts resolves @zana-ai/core via a dynamic require() (the _core()
// helper), which vi.mock() does NOT intercept — see manager-subagent-mode.
// So we spy on the REAL core, drive moduleConfig.get() to throw, and assert
// startTeam takes the process path. The checkpoint store/resume modules ARE
// static imports, so vi.mock intercepts those. No real Claude, no real clock.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@zana-ai/work/src/teams/store.ts", () => ({
  getTeam: vi.fn(() => null),
  saveTeam: vi.fn(),
  listTeams: vi.fn(() => []),
  deleteTeam: vi.fn(),
}));
vi.mock("@zana-ai/work/src/runs/checkpoint/store.ts", () => ({
  addCompletedAgent: vi.fn(), update: vi.fn(), addPendingAgent: vi.fn(),
  list: vi.fn(() => []), load: vi.fn(() => null),
}));
vi.mock("@zana-ai/work/src/runs/checkpoint/resume.ts", () => ({
  createFromTeam: vi.fn(() => ({ id: "cp-test" })),
  resume: vi.fn(() => ({ ok: true })),
}));

import * as teamStore from "@zana-ai/work/src/teams/store.ts";

let realCore: any;
let manager: typeof import("@zana-ai/work/src/teams/manager.ts");
let cwd: string;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let configThrows: boolean;

const PROFILES: Record<string, any> = {
  orchestrator: { id: "orchestrator", displayName: "Lead", appendSystemPrompt: "", allowedTools: [], disallowedTools: [] },
  coder: { id: "coder", displayName: "Coder", description: "writes code" },
};

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-es-throws-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
  cwd = mkdtempSync(join(tmpdir(), "zana-es-cwd-"));

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "lead-1", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockImplementation((id: string) => PROFILES[id] || null);
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);
  // The config read is the failure point under test.
  vi.spyOn(realCore.modules.config, "get").mockImplementation(() => {
    if (configThrows) throw new Error("module config unavailable");
    return { system: { executionStrategy: "process" } };
  });

  manager = await import("@zana-ai/work/src/teams/manager.ts");
}, 60000);

function makeTeam() {
  return {
    id: "team-es", name: "ES Team", slug: "es-team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: ["coder"],
    slots: [{ profileId: "coder", quantity: 1 }],
    // NOTE: no executionStrategy — forces the global-config consultation path.
  };
}

beforeEach(() => {
  vi.useFakeTimers(); // suppress startTeam's 2s writeToAgent timer
  configThrows = true;
  spawnSpy.mockClear();
  (teamStore.getTeam as any).mockImplementation((id: string) => (id === "team-es" ? makeTeam() : null));
});

afterEach(() => {
  try { manager.stopTeam("team-es"); vi.runAllTimers(); } catch {}
  vi.useRealTimers();
});

describe("startTeam — resolveExecutionStrategy falls back when module config throws", () => {
  it("does not throw and starts the team via the process strategy", () => {
    let res: any;
    expect(() => { res = manager.startTeam("team-es", { headless: true, cwd }); }).not.toThrow();

    expect(res.ok).toBe(true);
    // process path: no subagent surface and no .claude/agents recipes provisioned.
    expect(res.executionStrategy).toBeUndefined();
    expect(existsSync(join(cwd, ".claude", "agents"))).toBe(false);
    // Exactly ONE lead process spawned.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
