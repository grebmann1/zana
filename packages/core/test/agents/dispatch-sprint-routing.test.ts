/**
 * Unit tests for agents/dispatch.ts — the sprint routing branches.
 *
 * dispatch.ts is a command router; for the sprint actions its whole job is to
 * forward the right argument shape to work.tickets.service and return the
 * service result unchanged (dispatch.ts:271-285). Two contracts matter and are
 * easy to break in a refactor:
 *   - list/create pass the full `params` object through,
 *   - board/start/end extract `params.sprintId` and pass it positionally.
 * None of these branches were covered by the existing dispatch suite.
 *
 * The shared dispatch.test.ts mocks lazyRequire with a generic Proxy that makes
 * work.tickets.service unusable, so (like dispatch-ticket-edit.test.ts) this
 * file injects a controllable `work` fake for the "@zana-ai/work" lazyRequire.
 * These branches never touch the swarm package or any runtime relative
 * require(), so they stay deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockListSprints,
  mockGetSprintBoard,
  mockCreateSprint,
  mockStartSprint,
  mockEndSprint,
} = vi.hoisted(() => ({
  mockListSprints: vi.fn(),
  mockGetSprintBoard: vi.fn(),
  mockCreateSprint: vi.fn(),
  mockStartSprint: vi.fn(),
  mockEndSprint: vi.fn(),
}));

vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return {
        tickets: {
          service: {
            listSprints: mockListSprints,
            getSprintBoard: mockGetSprintBoard,
            createSprint: mockCreateSprint,
            startSprint: mockStartSprint,
            endSprint: mockEndSprint,
          },
        },
      };
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

describe("handleOrchestratorCommand — sprint routing", () => {
  it("sprint_list forwards the full params object and returns the service result", async () => {
    const sprints = [{ id: "s1" }, { id: "s2" }];
    mockListSprints.mockReturnValue(sprints);

    const result = await call("sprint_list", { status: "active", limit: 5 });

    expect(result).toBe(sprints);
    // `action` is destructured off; the remaining params are forwarded intact.
    expect(mockListSprints).toHaveBeenCalledWith({ status: "active", limit: 5 });
  });

  it("sprint_create forwards the full params object to createSprint", async () => {
    const created = { id: "s-new", name: "Sprint 1" };
    mockCreateSprint.mockReturnValue(created);

    const result = await call("sprint_create", { name: "Sprint 1", goal: "ship it" });

    expect(result).toBe(created);
    expect(mockCreateSprint).toHaveBeenCalledWith({ name: "Sprint 1", goal: "ship it" });
  });

  it("sprint_board extracts sprintId and passes it positionally", async () => {
    const board = { sprintId: "s1", columns: {} };
    mockGetSprintBoard.mockReturnValue(board);

    const result = await call("sprint_board", { sprintId: "s1" });

    expect(result).toBe(board);
    expect(mockGetSprintBoard).toHaveBeenCalledWith("s1");
  });

  it("sprint_start passes only sprintId to startSprint", async () => {
    mockStartSprint.mockReturnValue({ ok: true });

    await call("sprint_start", { sprintId: "s1", ignored: "field" });

    expect(mockStartSprint).toHaveBeenCalledWith("s1");
  });

  it("sprint_end passes only sprintId to endSprint", async () => {
    mockEndSprint.mockReturnValue({ ok: true });

    await call("sprint_end", { sprintId: "s1", ignored: "field" });

    expect(mockEndSprint).toHaveBeenCalledWith("s1");
  });
});
