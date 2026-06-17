/**
 * Unit tests for agents/dispatch.ts — the `discover_agents` swarm P2P branch.
 *
 * `discover_agents` rebuilds the swarm routing table from the local agent
 * registry (plus any sub-daemons) and, when a `query` is supplied, returns only
 * the agents whose id / agentName / profileName match. This branch had no
 * routing coverage. The test is deterministic: `listAgents` is stubbed to a
 * fixed list, no sub-daemons are registered (so `getSubDaemonPorts()` is empty
 * and no HTTP calls fire), and the asserted output carries no time-sensitive
 * fields.
 *
 * Following the dispatch-send-ack-routing convention, the swarm package is left
 * REAL (bare `@zana-ai/*` mocks don't intercept under the repo's noExternal
 * inlining); only the statically-imported core deps are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { listAgents } from "@zana-ai/core/src/agents/lifecycle.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, () => "/ws");
}

describe("handleOrchestratorCommand — discover_agents", () => {
  beforeEach(() => {
    vi.mocked(listAgents).mockReturnValue([] as any);
  });

  it("returns an empty list when no agents are registered", async () => {
    const result = (await call("discover_agents")) as any[];
    expect(result).toEqual([]);
  });

  it("registers local agents and filters them by query", async () => {
    vi.mocked(listAgents).mockReturnValue([
      { id: "agent-researcher-1", profileName: "researcher" },
      { id: "agent-coder-2", profileName: "coder" },
    ] as any);

    const result = (await call("discover_agents", { query: "research" })) as any[];

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "agent-researcher-1",
      daemonId: "local",
      daemonPort: null,
      agentName: "researcher",
      profileName: "researcher",
    });
  });
});
