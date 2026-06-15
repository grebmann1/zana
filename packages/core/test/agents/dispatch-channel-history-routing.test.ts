/**
 * Unit tests for agents/dispatch.ts — the `channel_history` P2P branch.
 *
 * `channel_history` forwards the channel name and a { limit } option to the
 * swarm router's getChannelHistory and returns the result verbatim. For a
 * channel that was never created the router returns an empty array without
 * touching disk or the network, so this stays deterministic. Using a unique,
 * never-published channel name per test keeps the assertion independent of
 * module-global channel state and of test execution order. This branch is not
 * covered elsewhere.
 *
 * As in dispatch-channel-subscribe-routing, the swarm package is left REAL
 * (bare `@zana-ai/*` mocks don't intercept under the repo's noExternal
 * inlining); only the statically-imported core deps are stubbed.
 */
import { describe, it, expect, vi } from "vitest";

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
  listProfiles: vi.fn(() => []),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  listTeams: vi.fn(() => []),
  listRunningTeams: vi.fn(() => []),
}));

vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, () => "/ws");
}

describe("handleOrchestratorCommand — channel_history", () => {
  it("returns an empty history for a channel that was never created", async () => {
    const result = await call("channel_history", {
      channel: "ch-hist-never-3a9f2b",
      limit: 10,
    });
    expect(result).toEqual([]);
  });

  it("treats distinct unknown channels independently (no cross-channel bleed)", async () => {
    const a = await call("channel_history", { channel: "ch-hist-a-7c1d" });
    const b = await call("channel_history", { channel: "ch-hist-b-8e2f" });
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});
