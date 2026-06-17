/**
 * Unit tests for agents/dispatch.ts — profile mutation routing branches.
 *
 * dispatch.test.ts already covers the read side (get_profile / list_profiles),
 * but the write side — save_profile and delete_profile — is not exercised.
 * Both branches delegate to profile-store and reshape the result into the
 * orchestrator's response envelope; this verifies that delegation and shape.
 *
 * profile-store and lifecycle are mocked (the same reliably-intercepted seams
 * used by dispatch.test.ts) so no real filesystem, spawning, or network occurs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSaveProfile, mockDeleteProfile } = vi.hoisted(() => ({
  mockSaveProfile: vi.fn(),
  mockDeleteProfile: vi.fn(),
}));

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
  saveProfile: mockSaveProfile,
  deleteProfile: mockDeleteProfile,
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));

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

describe("handleOrchestratorCommand — save_profile", () => {
  it("persists the profile and returns only id + displayName from the saved record", async () => {
    const incoming = { id: "p1", displayName: "Coder", systemPrompt: "secret" };
    // profile-store may normalise/augment the record on save; the response must
    // reflect the SAVED record (id/displayName), not blindly echo the input.
    mockSaveProfile.mockReturnValue({ id: "p1", displayName: "Coder", extra: "ignored" });

    const result = (await call("save_profile", { profile: incoming })) as any;

    expect(mockSaveProfile).toHaveBeenCalledWith(incoming);
    expect(result).toEqual({ ok: true, id: "p1", displayName: "Coder" });
    // Internal fields from the saved record must not leak through.
    expect(result).not.toHaveProperty("extra");
    expect(result).not.toHaveProperty("systemPrompt");
  });
});

describe("handleOrchestratorCommand — delete_profile", () => {
  it("surfaces a successful deletion as { ok: true }", async () => {
    mockDeleteProfile.mockReturnValue(true);

    const result = await call("delete_profile", { profileId: "p1" });

    expect(mockDeleteProfile).toHaveBeenCalledWith("p1");
    expect(result).toEqual({ ok: true });
  });

  it("surfaces a no-op deletion (unknown id) as { ok: false }", async () => {
    mockDeleteProfile.mockReturnValue(false);

    const result = await call("delete_profile", { profileId: "ghost" });

    expect(mockDeleteProfile).toHaveBeenCalledWith("ghost");
    expect(result).toEqual({ ok: false });
  });
});
