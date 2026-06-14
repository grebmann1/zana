// Tests for the dynamicSpawning=true code path inside buildOrchestratorPrompt
// (packages/work/src/teams/manager.ts lines 145-168).
//
// That branch calls _profileStore().listProfiles(), builds a full profile
// catalog, and injects it (plus per-constraint annotations) into the
// orchestrator's system prompt. No existing test exercises this path —
// every other manager test uses static teams with dynamicSpawning absent.
//
// WHY NOT vi.mock("@zana-ai/core"):
// manager.ts resolves @zana-ai/core via `function _core() { return require(...) }`
// at CALL SITES — not via top-level ESM imports.  vi.mock() intercepts ESM
// imports but NOT dynamic require() calls, so the mock object is never seen
// by the production code.  We therefore use vi.importActual + vi.spyOn on the
// REAL core objects (same strategy as manager-stop-query.test.ts).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 1. Mock static ESM dependencies (these ARE intercepted by vi.mock) ────────

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
  createFromTeam: vi.fn(() => ({ id: "cp-dyn" })),
  resume: vi.fn(() => ({ ok: true })),
}));

// ── 2. Spy on real @zana-ai/core before manager.ts module-scope code runs ────
//
// manager.ts runs `_agentManager().onAgentsChange(...)` at module load time.
// The spy must exist on the real object before any test code executes.

let realCore: any;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let listProfilesSpy: ReturnType<typeof vi.spyOn>;
let getProfileSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  // Give workspace-context a real tmpdir so that any path helper called
  // transitively through the real core does not throw "not initialized".
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-dyn-spawn-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = await vi.importActual("@zana-ai/core") as any;
  realCore.project.workspaceContext.init(tmpRoot);

  spawnSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-dyn", terminalId: null });

  vi.spyOn(realCore.agents.manager, "spawnInteractive")
    .mockReturnValue({ agentId: "orch-dyn-i", terminalId: "t-1" });
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);

  getProfileSpy = vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue(null);
  listProfilesSpy = vi.spyOn(realCore.agents.profileStore, "listProfiles").mockReturnValue([]);
});

// ── 3. Import manager AFTER spies are registered ─────────────────────────────

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ORCHESTRATOR_PROFILE = {
  id: "orchestrator",
  displayName: "Orchestrator",
  appendSystemPrompt: "",
  allowedTools: ["Read"],
  disallowedTools: [],
};

describe("manager — buildOrchestratorPrompt / dynamicSpawning branch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Restore default spy behaviours after clearAllMocks wipes them.
    spawnSpy.mockReturnValue({ agentId: "orch-dyn", terminalId: null });
    getProfileSpy.mockReturnValue(BASE_ORCHESTRATOR_PROFILE);
    listProfilesSpy.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls listProfiles() to build the catalog when dynamicSpawning=true", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-catalog",
      name: "Dynamic",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
    });

    manager.startTeam("team-dyn-catalog", { headless: true });

    expect(listProfilesSpy).toHaveBeenCalledOnce();
  });

  it("includes worker profile names in the orchestrator system prompt", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-names",
      name: "Dynamic Names",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
    });
    listProfilesSpy.mockReturnValue([
      { id: "coder", displayName: "Coder", description: "Writes code", icon: "🧑‍💻" },
      { id: "researcher", displayName: "Researcher", description: "Does research", icon: "🔍" },
    ]);

    manager.startTeam("team-dyn-names", { headless: true });

    const augmented = spawnSpy.mock.calls[0][0];
    expect(augmented.appendSystemPrompt).toContain("Coder");
    expect(augmented.appendSystemPrompt).toContain("Researcher");
  });

  it("filters orchestrator profiles out of the catalog", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-filter",
      name: "Dynamic Filter",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
    });
    listProfilesSpy.mockReturnValue([
      { id: "coder", displayName: "Coder", description: "Writes code" },
      { id: "team-orchestrator", displayName: "Team Orchestrator", description: "Should be hidden" },
      { id: "swarm-orchestrator", displayName: "Swarm Orchestrator", description: "Should also be hidden" },
    ]);

    manager.startTeam("team-dyn-filter", { headless: true });

    const augmented = spawnSpy.mock.calls[0][0];
    // Non-orchestrator profile is present
    expect(augmented.appendSystemPrompt).toContain("Coder");
    // Both orchestrator-id profiles must be suppressed
    expect(augmented.appendSystemPrompt).not.toContain("Team Orchestrator");
    expect(augmented.appendSystemPrompt).not.toContain("Swarm Orchestrator");
  });

  it("injects the explicit maxTotalWorkers constraint into the prompt", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-maxtotal",
      name: "Dynamic MaxTotal",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
      maxTotalWorkers: 8,
      rules: { maxConcurrentWorkers: 3 },
    });

    manager.startTeam("team-dyn-maxtotal", { headless: true });

    const augmented = spawnSpy.mock.calls[0][0];
    expect(augmented.appendSystemPrompt).toContain("Max total workers: 8");
    expect(augmented.appendSystemPrompt).toContain("Max concurrent workers: 3");
  });

  it("falls back to maxTotalWorkers=10 and maxConcurrentWorkers=5 when absent from team definition", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-defaults",
      name: "Dynamic Defaults",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
      // maxTotalWorkers and rules deliberately omitted
    });

    manager.startTeam("team-dyn-defaults", { headless: true });

    const augmented = spawnSpy.mock.calls[0][0];
    expect(augmented.appendSystemPrompt).toContain("Max total workers: 10");
    expect(augmented.appendSystemPrompt).toContain("Max concurrent workers: 5");
  });

  it("includes the requireApproval rule in the dynamic spawning prompt", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-dyn-approval",
      name: "Dynamic Approval",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      dynamicSpawning: true,
      rules: { requireApproval: true },
    });

    manager.startTeam("team-dyn-approval", { headless: true });

    const augmented = spawnSpy.mock.calls[0][0];
    expect(augmented.appendSystemPrompt).toContain("wait for user approval");
  });

  it("does NOT call listProfiles() for a static team (dynamicSpawning absent)", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-static-noprofile",
      name: "Static",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      // dynamicSpawning not set
    });

    manager.startTeam("team-static-noprofile", { headless: true });

    expect(listProfilesSpy).not.toHaveBeenCalled();
  });
});
