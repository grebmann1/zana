/**
 * Unit tests for the checkpoint-routing branches of agents/dispatch.ts.
 *
 * dispatch.ts forwards checkpoint_* actions to team-runtime and surfaces the
 * result unchanged. team-runtime is a static `import`, so it mocks cleanly
 * (unlike the swarm / modules-loader branches dispatch reaches via runtime
 * require()). These branches are not covered by dispatch-team-routing.test.ts.
 * The key contracts pinned here:
 *   - save/list forward the WHOLE params object
 *   - get/resume extract only checkpointId
 *   - resume AWAITS the runtime promise (returns the resolved value, not a Promise)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheckpointSave, mockCheckpointList, mockCheckpointGet, mockCheckpointResume } =
  vi.hoisted(() => ({
    mockCheckpointSave: vi.fn(),
    mockCheckpointList: vi.fn(),
    mockCheckpointGet: vi.fn(),
    mockCheckpointResume: vi.fn(),
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
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({
  checkpointSave: mockCheckpointSave,
  checkpointList: mockCheckpointList,
  checkpointGet: mockCheckpointGet,
  checkpointResume: mockCheckpointResume,
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

describe("dispatch — checkpoint routing", () => {
  it("checkpoint_save forwards the full params payload and returns the result verbatim", async () => {
    const saved = { checkpointId: "cp-1" };
    mockCheckpointSave.mockReturnValue(saved);
    const result = await call("checkpoint_save", { teamId: "t1", label: "milestone" });
    expect(result).toBe(saved);
    // The whole params object (sans `action`) is forwarded.
    expect(mockCheckpointSave).toHaveBeenCalledWith({ teamId: "t1", label: "milestone" });
  });

  it("checkpoint_list forwards the full params payload", async () => {
    mockCheckpointList.mockReturnValue([]);
    await call("checkpoint_list", { teamId: "t1" });
    expect(mockCheckpointList).toHaveBeenCalledWith({ teamId: "t1" });
  });

  it("checkpoint_get extracts only checkpointId", async () => {
    const cp = { id: "cp-9" };
    mockCheckpointGet.mockReturnValue(cp);
    const result = await call("checkpoint_get", { checkpointId: "cp-9", ignored: "x" });
    expect(result).toBe(cp);
    expect(mockCheckpointGet).toHaveBeenCalledWith("cp-9");
  });

  it("checkpoint_resume awaits the runtime promise and returns the resolved value", async () => {
    mockCheckpointResume.mockResolvedValue({ resumed: true, teamId: "t1" });
    const result = await call("checkpoint_resume", { checkpointId: "cp-9" });
    // Must be the resolved value, not a pending Promise.
    expect(result).toEqual({ resumed: true, teamId: "t1" });
    expect(mockCheckpointResume).toHaveBeenCalledWith("cp-9");
  });
});
