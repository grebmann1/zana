/**
 * Unit tests for agents/dispatch.ts — the `check_inbox` P2P routing branch.
 *
 * `check_inbox` resolves the inbox owner from `agentId` (falling back to
 * `terminalId`) and drains it via the swarm router. For an agent that has
 * never received a message the router returns an empty array via an early
 * return — no persistence, disk, or network I/O — so this is deterministic.
 *
 * The swarm package is intentionally left REAL here (bare `@zana-ai/*` mocks
 * don't intercept under the repo's `noExternal` inlining); only the
 * lightweight, statically-imported core deps are stubbed.
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

// Defer the cross-package proxies (@zana-ai/work, @zana-ai/extras) so the
// require-cycle never loads at module-eval time. `check_inbox` touches none of
// them; the direct `require("@zana-ai/swarm")` in dispatch stays real.
vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (_factory: any) => new Proxy({}, { get: () => vi.fn(() => ({})) }),
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, () => "/ws");
}

describe("handleOrchestratorCommand — check_inbox", () => {
  it("returns an empty array for an agent that has no messages", async () => {
    const result = await call("check_inbox", {
      agentId: "agent-with-no-inbox-1f2e3d",
    });
    expect(result).toEqual([]);
  });

  it("falls back to terminalId when agentId is absent (still empty inbox → [])", async () => {
    const result = await call("check_inbox", {
      terminalId: "terminal-with-no-inbox-4a5b6c",
    });
    expect(result).toEqual([]);
  });
});
