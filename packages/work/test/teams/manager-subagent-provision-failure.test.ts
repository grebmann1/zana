// Tests the provision-failure catch branch of startTeamAsSubagents in
// packages/work/src/teams/manager.ts (src lines ~323-332).
//
// In subagent execution strategy startTeam provisions .claude/agents/*.md
// recipes via subagentProvisioner.provisionTeam(). If that call THROWS (e.g.
// the working directory is unwritable, or the provisioner hits a recipe
// collision), startTeam must catch it and return
//   { ok: false, error: "failed to provision subagent recipes: <msg>" }
// rather than letting the exception escape startTeam — and it must NOT spawn a
// lead or register a running team. Every other subagent-mode test lets the REAL
// provisioner succeed, so this catch branch is otherwise unexercised.
//
// manager.ts resolves @zana-ai/core via dynamic require(), which vi.mock does
// NOT intercept (see manager-subagent-mode.test.ts). So we spy on the REAL core
// and drive subagentProvisioner.provisionTeam() to throw. Only the checkpoint
// store/resume (static imports) are vi.mock'd. No real Claude, no real clock.

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
let provisionSpy: ReturnType<typeof vi.spyOn>;

const PROFILES: Record<string, any> = {
  orchestrator: { id: "orchestrator", displayName: "Lead", appendSystemPrompt: "", allowedTools: [], disallowedTools: [] },
  coder: { id: "coder", displayName: "Coder", description: "writes code" },
};

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-sa-provfail-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
  cwd = mkdtempSync(join(tmpdir(), "zana-sa-provfail-cwd-"));

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "lead-1", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockImplementation((id: string) => PROFILES[id] || null);
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);
  // Force the subagent strategy globally so startTeam takes startTeamAsSubagents.
  vi.spyOn(realCore.modules.config, "get").mockImplementation(() => ({ system: { executionStrategy: "subagent" } }));
  // The provisioner is the failure point under test.
  provisionSpy = vi.spyOn(realCore.agents.subagentProvisioner, "provisionTeam");

  manager = await import("@zana-ai/work/src/teams/manager.ts");
}, 60000);

function makeTeam() {
  return {
    id: "team-provfail", name: "Provision Fail Team", slug: "provfail-team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: ["coder"],
    slots: [{ profileId: "coder", quantity: 1 }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnSpy.mockClear();
  (teamStore.getTeam as any).mockImplementation((id: string) => (id === "team-provfail" ? makeTeam() : null));
});

afterEach(() => {
  try { manager.stopTeam("team-provfail"); vi.runAllTimers(); } catch {}
  vi.useRealTimers();
});

describe("startTeam — subagent strategy provisioning failure", () => {
  it("returns ok:false with the provisioner error, does not spawn a lead, and does not register the team", () => {
    provisionSpy.mockImplementation(() => {
      throw new Error("disk full");
    });

    let res: any;
    expect(() => { res = manager.startTeam("team-provfail", { headless: true, cwd }); }).not.toThrow();

    expect(res.ok).toBe(false);
    expect(res.error).toBe("failed to provision subagent recipes: disk full");
    // The catch returns BEFORE spawning the lead and BEFORE registering the team.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(manager.getTeamStatus("team-provfail")).toBeNull();
  });
});
