// Tests for the subagent execution strategy in startTeam (manager.ts).
//
// When system.executionStrategy === "subagent" (or team.executionStrategy),
// startTeam must:
//   • provision .claude/agents/*.md recipes for the roster (one per worker),
//   • spawn ONE lead session (no separate worker processes),
//   • return { executionStrategy: "subagent", subagents: [...composite slugs] },
//   • refuse when worktree isolation is requested.
//
// manager.ts resolves @zana-ai/core via dynamic require(), which vi.mock does
// NOT intercept (see manager-auto-checkpoint.test.ts). So we spy on the REAL
// core: stub spawn, drive moduleConfig.executionStrategy, and let the REAL pure
// subagentProvisioner write recipes into a per-test temp working dir. Only the
// checkpoint store/resume (static imports) are vi.mock'd.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
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
let strategy: "process" | "subagent";

const PROFILES: Record<string, any> = {
  orchestrator: { id: "orchestrator", displayName: "Lead", appendSystemPrompt: "", allowedTools: [], disallowedTools: [] },
  coder: { id: "coder", displayName: "Coder", description: "writes code" },
  reviewer: { id: "reviewer", displayName: "Reviewer", description: "reviews code" },
};

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-sa-mode-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
  cwd = mkdtempSync(join(tmpdir(), "zana-sa-cwd-"));

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "lead-1", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockImplementation((id: string) => PROFILES[id] || null);
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);
  vi.spyOn(realCore.modules.config, "get").mockImplementation(() => ({ system: { executionStrategy: strategy } }));

  manager = await import("@zana-ai/work/src/teams/manager.ts");
}, 60000);

function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-sa", name: "SA Team", slug: "sa-team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: ["coder", "reviewer"],
    slots: [{ profileId: "coder", quantity: 1 }, { profileId: "reviewer", quantity: 1 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers(); // suppress startTeam's 2s writeToAgent timer
  strategy = "process";
  spawnSpy.mockClear();
  (teamStore.getTeam as any).mockImplementation((id: string) => (id === "team-sa" ? makeTeam() : null));
  // clean the recipe dir between tests
  try { rmSync(join(cwd, ".claude"), { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  // stopTeam schedules a 3s setTimeout to delete the running-team entry; under
  // fake timers it never fires, so advance them or the next test sees
  // "team already running".
  try { manager.stopTeam("team-sa"); vi.runAllTimers(); } catch {}
  vi.useRealTimers();
});

describe("startTeam — subagent strategy (global config)", () => {
  it("provisions recipes and spawns ONE lead when system.executionStrategy=subagent", () => {
    strategy = "subagent";
    const res: any = manager.startTeam("team-sa", { headless: true, cwd });

    expect(res.ok).toBe(true);
    expect(res.executionStrategy).toBe("subagent");
    expect(res.subagents.sort()).toEqual(["sa-team-coder", "sa-team-reviewer"]);
    // Real recipe files were written for the two workers (not the lead).
    const files = readdirSync(join(cwd, ".claude", "agents")).sort();
    expect(files).toEqual(["sa-team-coder.md", "sa-team-reviewer.md"]);
    // Exactly ONE process spawned (the lead).
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("bakes the dispatchable subagent_type list into the lead's prompt", () => {
    strategy = "subagent";
    manager.startTeam("team-sa", { headless: true, cwd });
    const profileArg: any = spawnSpy.mock.calls[0][0];
    expect(profileArg.appendSystemPrompt).toContain("sa-team-coder");
    expect(profileArg.appendSystemPrompt).toContain("sa-team-reviewer");
    expect(profileArg.appendSystemPrompt).toContain("Task tool");
  });

  it("restricts the lead's implementation tools and pins a clean MCP surface", () => {
    // Both were proven necessary by the live A/B run: without the Write/Edit/Bash
    // restriction the lead implements instead of delegating; without
    // strictMcpConfig the child inherits host MCP tools that shadow the Agent
    // dispatch tool.
    strategy = "subagent";
    manager.startTeam("team-sa", { headless: true, cwd });
    const profileArg: any = spawnSpy.mock.calls[0][0];
    expect(profileArg.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(profileArg.strictMcpConfig).toBe(true);
  });
});

describe("startTeam — subagent strategy (per-team override)", () => {
  it("honors team.executionStrategy even when global default is process", () => {
    strategy = "process";
    (teamStore.getTeam as any).mockImplementation((id: string) =>
      id === "team-sa" ? makeTeam({ executionStrategy: "subagent" }) : null);
    const res: any = manager.startTeam("team-sa", { headless: true, cwd });
    expect(res.executionStrategy).toBe("subagent");
    expect(existsSync(join(cwd, ".claude", "agents"))).toBe(true);
  });

  it("honors team.executionStrategy=process even when global default is subagent", () => {
    // Reverse of the above: an operator opts ONE team out of a globally-enabled
    // subagent strategy. resolveExecutionStrategy's per-team branch must win, so
    // startTeam takes the process path — no recipes, no subagent surface.
    strategy = "subagent";
    (teamStore.getTeam as any).mockImplementation((id: string) =>
      id === "team-sa" ? makeTeam({ executionStrategy: "process" }) : null);
    const res: any = manager.startTeam("team-sa", { headless: true, cwd });
    expect(res.ok).toBe(true);
    expect(res.executionStrategy).toBeUndefined();
    expect(existsSync(join(cwd, ".claude", "agents"))).toBe(false);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("startTeam — subagent strategy guards", () => {
  it("refuses worktree isolation (recipes would be invisible)", () => {
    strategy = "subagent";
    const res: any = manager.startTeam("team-sa", { headless: true, cwd, worktree: { branch: "x", path: "/wt" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/worktree/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe("startTeam — process strategy is unchanged (default)", () => {
  it("does NOT provision recipes when strategy=process", () => {
    strategy = "process";
    const res: any = manager.startTeam("team-sa", { headless: true, cwd });
    expect(res.ok).toBe(true);
    expect(res.executionStrategy).toBeUndefined();
    expect(existsSync(join(cwd, ".claude", "agents"))).toBe(false);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
