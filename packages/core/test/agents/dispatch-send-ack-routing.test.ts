/**
 * Unit tests for agents/dispatch.ts — the `send_ack` P2P acknowledgment branch.
 *
 * `send_ack` delegates to the swarm router's in-memory ack table. When no ack
 * was ever requested for the given message id, the router refuses with a stable
 * error shape rather than silently creating an entry. This branch is purely
 * in-memory — no disk persistence, no network, and the asserted result carries
 * no time-sensitive fields — so the test stays deterministic. Not covered
 * elsewhere.
 *
 * As in dispatch-channel-subscribe-routing, the swarm package is left REAL
 * (bare `@zana-ai/*` mocks don't intercept under the repo's noExternal
 * inlining); only the lightweight, statically-imported core deps are stubbed.
 * A unique message id keeps the module-global ack table from colliding.
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

describe("handleOrchestratorCommand — send_ack", () => {
  it("refuses with a stable error when no ack was requested for the message", async () => {
    const result = (await call("send_ack", {
      messageId: "msg-never-requested-7q8r9s",
      agentId: "agent-1",
      status: "received",
    })) as any;
    expect(result).toEqual({ ok: false, error: "no ack requested for this message" });
  });
});
