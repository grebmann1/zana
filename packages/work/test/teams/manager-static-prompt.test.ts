// Tests for the static team (dynamicSpawning absent) branch of
// buildOrchestratorPrompt inside packages/work/src/teams/manager.ts.
//
// Specifically verifies that the orchestrator's appendSystemPrompt contains:
//   • the displayName of every worker profile listed in slots
//   • per-role caps when a slot has quantity > 1
//   • the maxConcurrentWorkers rule when present on the team
//   • the requireApproval rule string when present
//
// WHY NOT vi.mock("@zana-ai/core"):
// manager.ts resolves @zana-ai/core via `function _core() { return require(...) }`
// at call sites — NOT via top-level ESM imports. vi.mock() intercepts ESM
// imports but NOT dynamic require() calls. We therefore use vi.importActual +
// vi.spyOn on the REAL core objects (same strategy as manager-stop-query.test.ts
// and manager-dynamic-spawning.test.ts).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 1. Mock static ESM dependencies ──────────────────────────────────────────

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
  createFromTeam: vi.fn(() => ({ id: "cp-static-prompt" })),
  resume: vi.fn(() => ({ ok: true })),
}));

// ── 2. Spy on real @zana-ai/core before manager.ts module-scope code runs ────

let realCore: any;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let getProfileSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-static-prompt-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = await vi.importActual("@zana-ai/core") as any;
  realCore.project.workspaceContext.init(tmpRoot);

  spawnSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-static", terminalId: null });

  vi.spyOn(realCore.agents.manager, "spawnInteractive")
    .mockReturnValue({ agentId: "orch-static-i", terminalId: "t-1" });
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);

  getProfileSpy = vi
    .spyOn(realCore.agents.profileStore, "getProfile")
    .mockReturnValue(null);
});

// ── 3. Import manager AFTER spies are in place ────────────────────────────────

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

const CODER_PROFILE = {
  id: "coder",
  displayName: "Coder",
  description: "Writes the code",
  icon: "🧑‍💻",
};

const REVIEWER_PROFILE = {
  id: "reviewer",
  displayName: "Reviewer",
  description: "Reviews pull requests",
  icon: "🔍",
};

/** Start a static team with the given definition and return the spawned profile. */
function startStaticTeam(teamDef: Record<string, any>) {
  (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue(teamDef);
  getProfileSpy.mockImplementation((id: string) => {
    if (id === "orchestrator") return BASE_ORCHESTRATOR_PROFILE;
    if (id === "coder") return CODER_PROFILE;
    if (id === "reviewer") return REVIEWER_PROFILE;
    return null;
  });
  spawnSpy.mockReturnValue({ agentId: `orch-${teamDef.id}`, terminalId: null });
  manager.startTeam(teamDef.id, { headless: true });
  return spawnSpy.mock.calls.at(-1)![0]; // augmented profile passed to spawnHeadlessAgent
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("manager — static team orchestrator prompt: worker list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spawnSpy.mockReturnValue({ agentId: "orch-static", terminalId: null });
    getProfileSpy.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes each worker profile's displayName in the system prompt", () => {
    const augmented = startStaticTeam({
      id: "team-static-workers",
      name: "Full Stack Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [
        { profileId: "coder", quantity: 1 },
        { profileId: "reviewer", quantity: 1 },
      ],
    });

    expect(augmented.appendSystemPrompt).toContain("Coder");
    expect(augmented.appendSystemPrompt).toContain("Reviewer");
  });

  it("includes the worker profile's id in the system prompt", () => {
    const augmented = startStaticTeam({
      id: "team-static-id",
      name: "ID Check",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [{ profileId: "coder", quantity: 1 }],
    });

    // The id is rendered as `(id: \`coder\`)` in the worker list
    expect(augmented.appendSystemPrompt).toContain("`coder`");
  });

  it("renders the total slot count as the sum of every slot's quantity", () => {
    const augmented = startStaticTeam({
      id: "team-static-total",
      name: "Total Slots Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [
        { profileId: "coder", quantity: 3 },
        { profileId: "reviewer", quantity: 1 },
      ],
    });

    // buildOrchestratorPrompt renders "(N total slots)" where N = Σ quantity.
    // 3 (coder) + 1 (reviewer) = 4 — not the slot *count* (2).
    expect(augmented.appendSystemPrompt).toContain("(4 total slots)");
    expect(augmented.appendSystemPrompt).not.toContain("(2 total slots)");
  });

  it("includes the per-role cap annotation when quantity > 1", () => {
    const augmented = startStaticTeam({
      id: "team-static-qty",
      name: "Scale Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [
        { profileId: "coder", quantity: 3 },
        { profileId: "reviewer", quantity: 1 },
      ],
    });

    // buildOrchestratorPrompt renders quantity > 1 as "3x <Name>"
    expect(augmented.appendSystemPrompt).toContain("3x");
    // And injects a Per-role caps rule block
    expect(augmented.appendSystemPrompt).toContain("Per-role caps");
    expect(augmented.appendSystemPrompt).toContain("max 3");
  });
});

describe("manager — static team orchestrator prompt: rules block", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spawnSpy.mockReturnValue({ agentId: "orch-static", terminalId: null });
    getProfileSpy.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects maxConcurrentWorkers rule when present on the team", () => {
    const augmented = startStaticTeam({
      id: "team-static-concurrent",
      name: "Concurrent Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      rules: { maxConcurrentWorkers: 4 },
    });

    expect(augmented.appendSystemPrompt).toContain("Max concurrent workers: 4");
  });

  it("omits the rules block when no rules are configured", () => {
    const augmented = startStaticTeam({
      id: "team-static-norules",
      name: "No Rules Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      rules: {},
    });

    // No rules → rulesBlock is empty → "Rules:" heading must not appear
    expect(augmented.appendSystemPrompt).not.toContain("Rules:\n");
  });

  it("includes requireApproval rule string in static team prompt", () => {
    const augmented = startStaticTeam({
      id: "team-static-approval",
      name: "Approval Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
      rules: { requireApproval: true },
    });

    expect(augmented.appendSystemPrompt).toContain("wait for user approval");
  });
});
