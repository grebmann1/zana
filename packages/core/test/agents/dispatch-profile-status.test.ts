/**
 * Unit tests for dispatch.ts routing branches that the sibling dispatch.test.ts
 * and dispatch-team-routing.test.ts leave uncovered: agent_status (success
 * shape + uptime), save_profile, and delete_profile.
 *
 * These actions route only through statically-imported deps (lifecycle,
 * profile-store), so they mock cleanly with no real spawning, PTY, or network.
 * (The spawn_agent / spawn_oneshot / event_emit branches reach modules via a
 * runtime require() that Vite does not transform in source-mode tests, so they
 * are intentionally out of scope here.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAgent, mockSaveProfile, mockDeleteProfile } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockSaveProfile: vi.fn(),
  mockDeleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  listAgents: vi.fn(() => []),
  getAgent: mockGetAgent,
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
  saveProfile: mockSaveProfile,
  deleteProfile: mockDeleteProfile,
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  listTeams: vi.fn(() => []),
}));

vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — agent_status (success)", () => {
  it("maps the agent to its public shape and reports a non-negative uptime", async () => {
    mockGetAgent.mockReturnValue({
      id: "a1",
      state: "active",
      lastAction: "Running: Bash",
      mode: "headless",
      spawnedAt: Date.now() - 5_000,
      secretInternalField: "should-not-appear",
    });

    const result = (await call("agent_status", { agentId: "a1" })) as any;

    expect(result).toMatchObject({
      id: "a1",
      state: "active",
      lastAction: "Running: Bash",
      mode: "headless",
    });
    // uptime is derived (now - spawnedAt): assert the contract, not an exact ms value.
    expect(typeof result.uptime).toBe("number");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    // Internal fields must not leak through the public mapping.
    expect(result).not.toHaveProperty("secretInternalField");
    expect(mockGetAgent).toHaveBeenCalledWith("a1");
  });
});

describe("dispatch — save_profile", () => {
  it("returns ok plus the saved id/displayName from the store", async () => {
    mockSaveProfile.mockReturnValue({ id: "p1", displayName: "Coder" });
    const profile = { displayName: "Coder", model: "sonnet" };

    const result = await call("save_profile", { profile });

    expect(result).toEqual({ ok: true, id: "p1", displayName: "Coder" });
    expect(mockSaveProfile).toHaveBeenCalledWith(profile);
  });
});

describe("dispatch — delete_profile", () => {
  it("surfaces the store's boolean delete result under `ok`", async () => {
    mockDeleteProfile.mockReturnValue(false);

    const result = await call("delete_profile", { profileId: "ghost" });

    expect(result).toEqual({ ok: false });
    expect(mockDeleteProfile).toHaveBeenCalledWith("ghost");
  });
});
