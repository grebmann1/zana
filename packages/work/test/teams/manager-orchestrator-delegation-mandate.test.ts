// Tests the delegation-mandate invariant of buildOrchestratorPrompt in
// packages/work/src/teams/manager.ts.
//
// Sibling suites (manager-static-prompt.test.ts) assert the worker list, slot
// counts, per-role caps and rules block — but NOTHING asserts the delegation
// mandate itself: the "You are the ORCHESTRATOR … you MUST NOT write code"
// directive that every team lead's system prompt is built around. That mandate
// is the entire point of the prompt (ADR 0012: a lead that keeps its
// implementation tools takes the cheap path and does the work itself instead of
// dispatching workers). If a refactor silently drops it, every prior test still
// passes while teams quietly stop delegating. This locks the invariant down.
//
// Mocking strategy mirrors manager-static-prompt.test.ts: manager.ts resolves
// @zana-ai/core via a dynamic require() (the _core() helper) which vi.mock()
// does NOT intercept, so we vi.importActual the real core and vi.spyOn the
// methods that would otherwise spawn a real Claude process. Fake timers
// suppress startTeam's 2s writeToAgent timeout. No real network, no real clock.

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
  createFromTeam: vi.fn(() => ({ id: "cp-delegation-mandate" })),
  resume: vi.fn(() => ({ ok: true })),
}));

let realCore: any;
let spawnSpy: ReturnType<typeof vi.spyOn>;
let getProfileSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "zana-delegation-mandate-test-"));
  mkdirSync(join(tmpRoot, ".zana"), { recursive: true });

  realCore = (await vi.importActual("@zana-ai/core")) as any;
  realCore.project.workspaceContext.init(tmpRoot);

  spawnSpy = vi
    .spyOn(realCore.agents.manager, "spawnHeadlessAgent")
    .mockReturnValue({ agentId: "orch-mandate", terminalId: null });
  vi.spyOn(realCore.agents.manager, "killAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "writeToAgent").mockReturnValue(undefined as any);
  vi.spyOn(realCore.agents.manager, "listAgents").mockReturnValue([]);
  getProfileSpy = vi
    .spyOn(realCore.agents.profileStore, "getProfile")
    .mockReturnValue(null);
});

import * as manager from "@zana-ai/work/src/teams/manager.ts";
import * as teamStore from "@zana-ai/work/src/teams/store.ts";

const ORCHESTRATOR_PROFILE = {
  id: "orchestrator",
  displayName: "Orchestrator",
  appendSystemPrompt: "",
  allowedTools: ["Read"],
  disallowedTools: [],
};

describe("manager — orchestrator prompt delegation mandate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spawnSpy.mockReturnValue({ agentId: "orch-mandate", terminalId: null });
    getProfileSpy.mockImplementation((id: string) =>
      id === "orchestrator" ? ORCHESTRATOR_PROFILE : null,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects the delegate-don't-implement mandate and artifact guidance into the lead's system prompt", () => {
    (teamStore.getTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "team-mandate",
      name: "Mandate Team",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: [],
      slots: [],
    });

    manager.startTeam("team-mandate", { headless: true });

    const augmented = spawnSpy.mock.calls.at(-1)![0] as any;
    const prompt: string = augmented.appendSystemPrompt;

    // The lead is framed as a non-implementing orchestrator for THIS team…
    expect(prompt).toContain('ORCHESTRATOR for "Mandate Team"');
    // …and is explicitly forbidden from writing code itself (the ADR-0012 invariant).
    expect(prompt).toContain("You MUST NOT write code");
    expect(prompt).toContain("You MUST spawn workers for ALL implementation tasks");
    // …and is told to consult shared planning artifacts before spawning.
    expect(prompt).toContain("zana_artifact_list");
  });
});
