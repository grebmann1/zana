// Regression guard for the static buildOrchestratorPrompt worker-list filter
// (packages/work/src/teams/manager.ts:93 — `if (!profile) return null` + the
// trailing `.filter(Boolean)`). A slot that references a profile the store
// cannot resolve must be SILENTLY DROPPED from the rendered worker roster while
// known workers still render. Every other static-prompt test seeds only
// resolvable slots, so this drop branch is otherwise unexercised.
//
// manager.ts resolves @zana-ai/core via `_core() { return require(...) }` at
// call sites, which vi.mock cannot intercept — so we spy on the REAL core
// objects (same strategy as manager-static-prompt.test.ts).

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
  createFromTeam: vi.fn(() => ({ id: "cp-unknown-slot" })), resume: vi.fn(() => ({ ok: true })),
}));

let spawnSpy: ReturnType<typeof vi.spyOn>;
let getProfileSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-unknown-slot-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
  const realCore = await vi.importActual("@zana-ai/core") as any;
  realCore.project.workspaceContext.init(tmpRoot);
  spawnSpy = vi.spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-unknown-slot", terminalId: null });
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  getProfileSpy = vi.spyOn(realCore.agents.profileStore, "getProfile").mockReturnValue(null);
});

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

describe("manager — static prompt drops a slot whose profile does not resolve", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it("omits the unresolved-profile slot from the worker list but keeps known workers", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-unknown-slot", name: "Partial Roster", orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [{ profileId: "coder", quantity: 1 }, { profileId: "ghost", quantity: 1 }],
    });
    getProfileSpy.mockImplementation((id: string) => {
      if (id === "orchestrator") return { id: "orchestrator", displayName: "Orchestrator", appendSystemPrompt: "", allowedTools: ["Read"], disallowedTools: [] };
      if (id === "coder") return { id: "coder", displayName: "Coder", description: "Writes code", icon: "🧑‍💻" };
      return null; // "ghost" is unresolvable
    });

    const result = manager.startTeam("team-unknown-slot", { headless: true });
    expect(result.ok).toBe(true);

    const augmented = spawnSpy.mock.calls.at(-1)![0] as any;
    // Known worker renders; the unresolved slot produces no roster line.
    expect(augmented.appendSystemPrompt).toContain("Coder");
    expect(augmented.appendSystemPrompt).not.toContain("ghost");
  });
});
