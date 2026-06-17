/**
 * Unit tests for dispatch.ts skill-routing branches (list_skills, get_skill,
 * save_skill, delete_skill, toggle_skill). These are left uncovered by the
 * sibling dispatch*.test.ts files.
 *
 * skillStore is reached through `lazyRequire(() => require("@zana-ai/extras")
 * .settings.skillStore)`. We mock lazy-require so that property access on the
 * fronted module resolves to controllable vi.fn()s — no real extras package,
 * filesystem, or network is touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { skillMocks } = vi.hoisted(() => ({
  skillMocks: {
    listSkills: vi.fn(),
    getSkill: vi.fn(),
    saveSkill: vi.fn(),
    deleteSkill: vi.fn(),
    toggleSkill: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
}));

// Static imports that dispatch.ts pulls in at module-load time. The skill
// branches don't exercise these, but they must resolve to avoid load errors.
vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  killAgent: vi.fn(),
  checkSystemResources: vi.fn(() => null),
  recordSpawnOverload: vi.fn(),
  clearSpawnOverloadStreak: vi.fn(),
  getSpawnThrottleStreakLimit: vi.fn(() => 5),
  getMaxConcurrentAgents: vi.fn(() => 10),
  spawnHeadlessAgent: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({
  getProfile: vi.fn(),
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  listTeams: vi.fn(() => []),
}));

vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

// Front every lazyRequire'd module with a Proxy. Skill methods resolve to our
// controllable mocks; anything else (e.g. @zana-ai/work) is a harmless no-op.
vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          skillMocks[prop] ?? vi.fn(() => ({})),
      }
    ),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — list_skills", () => {
  it("returns the store's skill list verbatim", async () => {
    const skills = [{ id: "s1", name: "alpha" }, { id: "s2", name: "beta" }];
    skillMocks.listSkills.mockReturnValue(skills);

    const result = await call("list_skills");

    expect(result).toBe(skills);
    expect(skillMocks.listSkills).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch — get_skill", () => {
  it("returns the skill when found", async () => {
    const skill = { id: "s1", name: "alpha", enabled: true };
    skillMocks.getSkill.mockReturnValue(skill);

    const result = await call("get_skill", { skillId: "s1" });

    expect(result).toBe(skill);
    expect(skillMocks.getSkill).toHaveBeenCalledWith("s1");
  });

  it("returns an error when the skill is missing", async () => {
    skillMocks.getSkill.mockReturnValue(undefined);

    const result = await call("get_skill", { skillId: "ghost" });

    expect(result).toEqual({ error: "skill not found: ghost" });
  });
});

describe("dispatch — save_skill", () => {
  it("returns ok plus the saved id/name from the store", async () => {
    skillMocks.saveSkill.mockReturnValue({ id: "s1", name: "alpha" });
    const skill = { name: "alpha", body: "do alpha" };

    const result = await call("save_skill", { skill });

    expect(result).toEqual({ ok: true, id: "s1", name: "alpha" });
    expect(skillMocks.saveSkill).toHaveBeenCalledWith(skill);
  });
});

describe("dispatch — delete_skill", () => {
  it("surfaces the store's boolean delete result under `ok`", async () => {
    skillMocks.deleteSkill.mockReturnValue(true);

    const result = await call("delete_skill", { skillId: "s1" });

    expect(result).toEqual({ ok: true });
    expect(skillMocks.deleteSkill).toHaveBeenCalledWith("s1");
  });
});

describe("dispatch — toggle_skill", () => {
  it("forwards skillId and enabled flag and surfaces the result under `ok`", async () => {
    skillMocks.toggleSkill.mockReturnValue(true);

    const result = await call("toggle_skill", { skillId: "s1", enabled: false });

    expect(result).toEqual({ ok: true });
    expect(skillMocks.toggleSkill).toHaveBeenCalledWith("s1", false);
  });
});
