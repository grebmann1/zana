/**
 * Unit tests for agents/dispatch.ts — the "ready ticket" routing branches
 * (ticket_claim_next / ticket_list_ready) added for sprint-aware auto-pickup.
 *
 * Like the other ticket branches, these don't reshape data; their job is to
 * forward the MCP payload to the right `work.tickets.service` method with the
 * arguments in the right POSITIONAL order — the easy-to-break contract:
 *   claimNextReady(agentId, agentName, profileId, { sprintId })
 *   listReadyTickets({ sprintId })
 * A re-order or a dropped sprintId would corrupt auto-pickup while still
 * "passing" any test that only checks the return value, so we assert the
 * call shape (and that the service result is returned verbatim).
 *
 * `work` is captured at module-load via lazyRequire("@zana-ai/work"); we inject
 * a controllable fake for that call and harmless stubs for the statically
 * imported deps so module load doesn't touch real lifecycle/swarm code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { svc } = vi.hoisted(() => ({
  svc: {
    claimNextReady: vi.fn(),
    listReadyTickets: vi.fn(),
  },
}));

vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { tickets: { service: svc } };
    }
    return new Proxy({}, { get: () => vi.fn(() => ({})) });
  },
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
  listProfiles: vi.fn(() => []),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));
vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — ready ticket routing", () => {
  it("ticket_claim_next forwards (agentId, agentName, profileId, { sprintId }) and returns the result", async () => {
    svc.claimNextReady.mockReturnValue({ id: "T-9", status: "in-progress" });

    const result = await call("ticket_claim_next", {
      agentId: "a1",
      agentName: "Alice",
      profileId: "p1",
      sprintId: "S-1",
    });

    expect(svc.claimNextReady).toHaveBeenCalledWith("a1", "Alice", "p1", { sprintId: "S-1" });
    expect(result).toEqual({ id: "T-9", status: "in-progress" });
  });

  it("ticket_claim_next still passes an options object (sprintId undefined) when no sprint is given", async () => {
    await call("ticket_claim_next", { agentId: "a1", agentName: "Alice", profileId: "p1" });

    expect(svc.claimNextReady).toHaveBeenCalledWith("a1", "Alice", "p1", { sprintId: undefined });
  });

  it("ticket_list_ready forwards { sprintId } and returns the service result verbatim", async () => {
    const ready = [{ id: "T-1" }, { id: "T-2" }];
    svc.listReadyTickets.mockReturnValue(ready);

    const result = await call("ticket_list_ready", { sprintId: "S-2" });

    expect(svc.listReadyTickets).toHaveBeenCalledWith({ sprintId: "S-2" });
    expect(result).toBe(ready);
  });
});
