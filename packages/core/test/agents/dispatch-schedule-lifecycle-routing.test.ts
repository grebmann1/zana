/**
 * Unit tests for dispatch.ts — the schedule lifecycle routing branches that the
 * sibling dispatch-schedule-routing.test.ts leaves uncovered: schedule_create,
 * schedule_list, schedule_enable, schedule_disable, schedule_trigger, and
 * schedule_reload (dispatch.ts:336-366).
 *
 * Those branches are thin, but each encodes an argument-extraction contract
 * worth locking: create forwards the whole params object, list/reload take no
 * args, and enable/disable/trigger pull only `params.id` (NOT the whole params)
 * before delegating to the scheduler service. The service is reached lazily via
 * `lazyRequire("@zana-ai/work").scheduling.service`, so we inject a controllable
 * fake exactly as dispatch-schedule-routing does — fully deterministic, no disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockScheduler } = vi.hoisted(() => ({
  mockScheduler: {
    createSchedule: vi.fn(),
    listSchedules: vi.fn(),
    enableSchedule: vi.fn(),
    disableSchedule: vi.fn(),
    triggerSchedule: vi.fn(),
    loadFromDisk: vi.fn(),
  },
}));

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") return { scheduling: { service: mockScheduler } };
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
  getProfile: vi.fn(), listProfiles: vi.fn(() => []), saveProfile: vi.fn(), deleteProfile: vi.fn(),
}));
vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — schedule lifecycle routing", () => {
  it("schedule_create forwards the whole params object and returns the created schedule", async () => {
    mockScheduler.createSchedule.mockReturnValue({ id: "s1", status: "active" });
    const params = { name: "nightly", cron: "0 0 * * *" };
    const result = await call("schedule_create", params);
    expect(result).toEqual({ id: "s1", status: "active" });
    // The whole action payload (sans `action`) is handed to the service.
    expect(mockScheduler.createSchedule).toHaveBeenCalledWith(params);
  });

  it("schedule_list delegates with no arguments and returns the service's list verbatim", async () => {
    mockScheduler.listSchedules.mockReturnValue([{ id: "s1" }, { id: "s2" }]);
    const result = await call("schedule_list");
    expect(result).toEqual([{ id: "s1" }, { id: "s2" }]);
    expect(mockScheduler.listSchedules).toHaveBeenCalledWith();
  });

  it("schedule_enable extracts only params.id", async () => {
    mockScheduler.enableSchedule.mockReturnValue({ id: "s1", enabled: true });
    const result = await call("schedule_enable", { id: "s1", ignored: "x" });
    expect(result).toEqual({ id: "s1", enabled: true });
    expect(mockScheduler.enableSchedule).toHaveBeenCalledWith("s1");
  });

  it("schedule_disable extracts only params.id", async () => {
    mockScheduler.disableSchedule.mockReturnValue({ id: "s1", enabled: false });
    const result = await call("schedule_disable", { id: "s1" });
    expect(result).toEqual({ id: "s1", enabled: false });
    expect(mockScheduler.disableSchedule).toHaveBeenCalledWith("s1");
  });

  it("schedule_trigger extracts only params.id", async () => {
    mockScheduler.triggerSchedule.mockReturnValue({ ok: true, runId: "r1" });
    const result = await call("schedule_trigger", { id: "s1" });
    expect(result).toEqual({ ok: true, runId: "r1" });
    expect(mockScheduler.triggerSchedule).toHaveBeenCalledWith("s1");
  });

  it("schedule_reload delegates with no arguments and returns the reload summary", async () => {
    mockScheduler.loadFromDisk.mockReturnValue({ started: 3, skipped: 1 });
    const result = await call("schedule_reload");
    expect(result).toEqual({ started: 3, skipped: 1 });
    expect(mockScheduler.loadFromDisk).toHaveBeenCalledWith();
  });
});
