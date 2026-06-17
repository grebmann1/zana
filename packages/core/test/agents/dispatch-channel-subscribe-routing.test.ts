/**
 * Unit tests for agents/dispatch.ts — the `subscribe_channel` / `list_channels`
 * P2P channel-routing branches.
 *
 * `subscribe_channel` lazily creates the named channel and adds the agent to
 * its subscriber set; `list_channels` reports every channel's subscriber and
 * message counts. Both are in-memory only — no disk persistence, no network,
 * and no time-sensitive fields are asserted (a fresh channel has lastActivity
 * null), so this stays deterministic. Neither action is covered elsewhere.
 *
 * As in dispatch-check-inbox-routing, the swarm package is left REAL (bare
 * `@zana-ai/*` mocks don't intercept under the repo's noExternal inlining);
 * only the lightweight, statically-imported core deps are stubbed. Each test
 * uses a unique channel name so module-global channel state can't collide.
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

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, () => "/ws");
}

describe("handleOrchestratorCommand — subscribe_channel / list_channels", () => {
  it("subscribe_channel creates a fresh channel with zero history", async () => {
    const result = (await call("subscribe_channel", {
      channel: "ch-fresh-9a8b7c",
      agentId: "agent-1",
    })) as any;
    expect(result).toEqual({ ok: true, channel: "ch-fresh-9a8b7c", historyCount: 0 });
  });

  it("list_channels reports the subscription with subscriber count and null activity", async () => {
    await call("subscribe_channel", { channel: "ch-listed-1d2e3f", agentId: "agent-1" });
    const channels = (await call("list_channels")) as any[];
    const entry = channels.find((c) => c.name === "ch-listed-1d2e3f");
    expect(entry).toEqual({
      name: "ch-listed-1d2e3f",
      subscribers: 1,
      messageCount: 0,
      lastActivity: null,
    });
  });

  it("counts distinct subscribers and treats a repeat subscribe as idempotent", async () => {
    const chan = "ch-multi-4g5h6i";
    await call("subscribe_channel", { channel: chan, agentId: "agent-1" });
    await call("subscribe_channel", { channel: chan, agentId: "agent-2" });
    await call("subscribe_channel", { channel: chan, agentId: "agent-1" }); // duplicate
    const channels = (await call("list_channels")) as any[];
    const entry = channels.find((c) => c.name === chan);
    expect(entry.subscribers).toBe(2);
  });
});
