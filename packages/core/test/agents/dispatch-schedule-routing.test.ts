/**
 * Unit tests for agents/dispatch.ts — the `schedule_*` routing branches.
 *
 * The schedule actions delegate to the scheduler service reached lazily via
 * `lazyRequire("@zana-ai/work").scheduling.service` (dispatch.ts:35, 336-366).
 * Most are thin pass-throughs, but two do reshaping the service itself does not:
 *   - schedule_get fans out to getSchedule + getRunHistory and combines them
 *     into a single `{ schedule, history }` object.
 *   - schedule_update / schedule_delete destructure / coerce the params shape
 *     (`{ id, ...fields }` → updateSchedule(id, fields); boolean → `{ ok }`).
 *
 * The shared dispatch.test.ts mocks lazy-require with a generic Proxy, so these
 * branches are untested there. This file injects a controllable scheduler
 * service the same way dispatch-artifact-routing injects the artifact store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockScheduler } = vi.hoisted(() => ({
  mockScheduler: {
    createSchedule: vi.fn(),
    listSchedules: vi.fn(),
    getSchedule: vi.fn(),
    getRunHistory: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    enableSchedule: vi.fn(),
    disableSchedule: vi.fn(),
    triggerSchedule: vi.fn(),
    loadFromDisk: vi.fn(),
  },
}));

// `work` is captured at module load via lazyRequire("@zana-ai/work"); hand back
// a controllable fake for that call and a harmless Proxy for the skillStore
// factory form so module load doesn't blow up.
vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { scheduling: { service: mockScheduler } };
    }
    return new Proxy({}, { get: () => vi.fn(() => ({})) });
  },
}));

// Imported/required at module load — stub so no real lifecycle/swarm loads.
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
  getProfile: vi.fn(), listProfiles: vi.fn(() => []), saveProfile: vi.fn(), deleteProfile: vi.fn(),
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

describe("handleOrchestratorCommand — schedule_get", () => {
  it("combines getSchedule and getRunHistory into a single { schedule, history }", async () => {
    const schedule = { id: "s1", cron: "0 * * * *" };
    const history = [{ runId: "r1", ok: true }];
    mockScheduler.getSchedule.mockReturnValue(schedule);
    mockScheduler.getRunHistory.mockReturnValue(history);

    const result = await call("schedule_get", { scheduleId: "s1" });

    expect(result).toEqual({ schedule, history });
    expect(mockScheduler.getSchedule).toHaveBeenCalledWith("s1");
    expect(mockScheduler.getRunHistory).toHaveBeenCalledWith("s1");
  });
});

describe("handleOrchestratorCommand — schedule_update", () => {
  it("forwards only the non-id fields to updateSchedule(id, fields)", async () => {
    const updated = { id: "s1", cron: "*/5 * * * *" };
    mockScheduler.updateSchedule.mockReturnValue(updated);

    const result = await call("schedule_update", { id: "s1", cron: "*/5 * * * *", enabled: true });

    expect(result).toBe(updated);
    expect(mockScheduler.updateSchedule).toHaveBeenCalledWith("s1", { cron: "*/5 * * * *", enabled: true });
  });
});

describe("handleOrchestratorCommand — schedule_delete", () => {
  it("wraps the service's boolean result in an { ok } shape", async () => {
    mockScheduler.deleteSchedule.mockReturnValue(false);
    const result = await call("schedule_delete", { id: "s9" });
    expect(result).toEqual({ ok: false });
    expect(mockScheduler.deleteSchedule).toHaveBeenCalledWith("s9");
  });
});
