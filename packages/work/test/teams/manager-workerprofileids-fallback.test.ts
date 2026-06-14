// Regression guard for the `team.slots || team.workerProfileIds.map(...)`
// fallback inside startTeam / buildOrchestratorPrompt (manager.ts line ~88).
//
// Every other manager test passes an explicit `slots` array, so the fallback —
// where a team defined ONLY with `workerProfileIds` (no `slots`) has its slots
// derived as one-per-id, quantity 1 — was never exercised. This test defines a
// team with NO `slots` key at all and asserts the orchestrator system prompt
// still lists every worker profile.
//
// Mocking strategy mirrors manager-static-prompt.test.ts: manager.ts resolves
// @zana-ai/core via a runtime require() (not a top-level ESM import), so we
// vi.spyOn the REAL core objects rather than vi.mock("@zana-ai/core").

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
  createFromTeam: vi.fn(() => ({ id: "cp-wpi-fallback" })),
  resume: vi.fn(() => ({ ok: true })),
}));

let realCore: any;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let getProfileSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-wpi-fallback-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  spawnSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-wpi", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);

  getProfileSpy = vi
    .spyOn(realCore.agents.profileStore, "getProfile")
    .mockReturnValue(null);
});

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

const BASE_ORCHESTRATOR_PROFILE = {
  id: "orchestrator",
  displayName: "Orchestrator",
  appendSystemPrompt: "",
  allowedTools: ["Read"],
  disallowedTools: [],
};
const CODER_PROFILE = { id: "coder", displayName: "Coder", description: "Writes code", icon: "🧑‍💻" };
const REVIEWER_PROFILE = { id: "reviewer", displayName: "Reviewer", description: "Reviews PRs", icon: "🔍" };

describe("manager — startTeam workerProfileIds fallback (no slots)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spawnSpy.mockReturnValue({ agentId: "orch-wpi", terminalId: null });
    getProfileSpy.mockImplementation((id: string) => {
      if (id === "orchestrator") return BASE_ORCHESTRATOR_PROFILE;
      if (id === "coder") return CODER_PROFILE;
      if (id === "reviewer") return REVIEWER_PROFILE;
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives one quantity-1 slot per workerProfileId and lists each in the orchestrator prompt", () => {
    // NOTE: no `slots` key at all — exercises the `|| workerProfileIds.map(...)` branch.
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-wpi",
      name: "Fallback Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: ["coder", "reviewer"],
    });

    const result = manager.startTeam("team-wpi", { headless: true });
    expect(result.ok).toBe(true);

    const augmented = spawnSpy.mock.calls.at(-1)![0] as any;
    expect(augmented.appendSystemPrompt).toContain("Coder");
    expect(augmented.appendSystemPrompt).toContain("Reviewer");
    expect(augmented.appendSystemPrompt).toContain("`coder`");
    expect(augmented.appendSystemPrompt).toContain("`reviewer`");
    // Quantity defaults to 1, so no per-role cap annotation should appear.
    expect(augmented.appendSystemPrompt).not.toContain("Per-role caps");
  });
});
