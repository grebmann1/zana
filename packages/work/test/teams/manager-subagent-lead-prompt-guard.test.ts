// Regression guard for buildSubagentLeadPrompt (manager.ts, subagent strategy).
//
// The existing manager-subagent-mode suite asserts the lead prompt lists each
// dispatchable subagent_type slug and mentions the Task tool. It does NOT lock
// two safety-critical pieces of the prompt that ADR 0012 relies on:
//   • the foreign-subagent guard wording ("never invent a subagent_type" /
//     "never dispatch one not listed here") that stops the lead from
//     hallucinating a teammate that was never provisioned, and
//   • the per-role DESCRIPTION rendered next to each subagent_type, which is
//     what tells the lead WHICH teammate to dispatch for a given subtask.
// A regression dropping either would still pass every current test. This locks
// both into the lead's appendSystemPrompt.
//
// manager.ts resolves @zana-ai/core via dynamic require(), which vi.mock does
// NOT intercept — so we spy on the REAL core (same strategy as
// manager-subagent-mode.test.ts) and only vi.mock the statically-imported
// checkpoint store/resume and team store.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  createFromTeam: vi.fn(() => ({ id: "cp-guard" })),
  resume: vi.fn(() => ({ ok: true })),
}));

import * as teamStore from "@zana-ai/work/src/teams/store.ts";

let realCore: any;
let manager: typeof import("@zana-ai/work/src/teams/manager.ts");
let cwd: string;
let spawnSpy: ReturnType<typeof vi.spyOn>;

const PROFILES: Record<string, any> = {
  orchestrator: { id: "orchestrator", displayName: "Lead", appendSystemPrompt: "", allowedTools: [], disallowedTools: [] },
  coder: { id: "coder", displayName: "Coder", description: "writes the production code" },
  reviewer: { id: "reviewer", displayName: "Reviewer", description: "reviews pull requests" },
};

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-sa-guard-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
  cwd = mkdtempSync(join(tmpdir(), "zana-sa-guard-cwd-"));

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  vi.spyOn(realCore.agents.manager, "onAgentsChange").mockImplementation(() => () => {});
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent").mockReturnValue({ agentId: "lead-1", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  vi.spyOn(realCore.agents.profileStore, "getProfile").mockImplementation((id: string) => PROFILES[id] || null);
  vi.spyOn(realCore.events.bus, "emit").mockReturnValue(true as any);
  // Globally enable the subagent strategy so startTeam takes the subagent path.
  vi.spyOn(realCore.modules.config, "get").mockImplementation(() => ({ system: { executionStrategy: "subagent" } }));

  manager = await import("@zana-ai/work/src/teams/manager.ts");
}, 60000);

function makeTeam() {
  return {
    id: "team-guard", name: "Guard Team", slug: "guard-team",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: ["coder", "reviewer"],
    slots: [{ profileId: "coder", quantity: 1 }, { profileId: "reviewer", quantity: 1 }],
  };
}

beforeEach(() => {
  vi.useFakeTimers(); // suppress startTeam's 2s writeToAgent timer
  spawnSpy.mockClear();
  (teamStore.getTeam as any).mockImplementation((id: string) => (id === "team-guard" ? makeTeam() : null));
  try { rmSync(join(cwd, ".claude"), { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  // stopTeam schedules a 3s cleanup timer; drain it so the next test does not
  // see "team already running".
  try { manager.stopTeam("team-guard"); vi.runAllTimers(); } catch {}
  vi.useRealTimers();
});

describe("buildSubagentLeadPrompt — foreign-subagent guard and role descriptions", () => {
  it("bakes the never-invent-a-subagent guard and each teammate's description into the lead prompt", () => {
    const res: any = manager.startTeam("team-guard", { headless: true, cwd });
    expect(res.executionStrategy).toBe("subagent");

    const profileArg: any = spawnSpy.mock.calls[0][0];
    const prompt: string = profileArg.appendSystemPrompt;

    // Foreign-subagent guard: the lead must be told never to fabricate or
    // dispatch a subagent_type that was not provisioned for this team.
    expect(prompt).toContain("never invent a subagent_type");
    expect(prompt).toContain("never dispatch one not listed here");

    // Each provisioned teammate is listed with its profile description so the
    // lead knows which one handles which kind of subtask.
    expect(prompt).toContain("writes the production code");
    expect(prompt).toContain("reviews pull requests");
  });
});
