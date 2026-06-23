/**
 * Regression for ticket 9c1d1bf5 — zana_schedule_create rejected every action
 * with "unknown action: [object Object]".
 *
 * Root cause: a parameter-name collision on the key `action`. The MCP boundary
 * built `{ action, ...params }` where `action` was the routing command
 * ("schedule_create") but `params.action` was the schedule's action object —
 * the spread clobbered the command, so the switch in handleOrchestratorCommand
 * received the OBJECT, missed every case, and fell through to
 * `default: unknown action: ${action}` → "[object Object]".
 *
 * Fix: callers route the command under the reserved `_action` key, which can't
 * be clobbered by an `action` parameter. This file drives handleOrchestratorCommand
 * exactly as callCore / the scheduled mcp_tool path now do, for every action
 * type, and asserts the action object reaches createSchedule intact (not
 * coerced) — i.e. the schedule is created, not rejected.
 *
 * Mirrors the injection style of dispatch-schedule-routing.test.ts: a
 * controllable scheduler service handed back through lazyRequire.
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

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { scheduling: { service: mockScheduler } };
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
  getProfile: vi.fn(), listProfiles: vi.fn(() => []), saveProfile: vi.fn(), deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));

vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

// The six action types the scheduler accepts (schema.ts ACTION_TYPES).
const ACTION_FIXTURES: Array<{ label: string; action: Record<string, unknown> }> = [
  { label: "prompt", action: { type: "prompt", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "spawn-agent", action: { type: "spawn-agent", profileId: "test-writer", prompt: "scan for gaps" } },
  { label: "team", action: { type: "team", teamId: "team-1", prompt: "go" } },
  { label: "command", action: { type: "command", command: ["npm", "test"] } },
  { label: "workflow", action: { type: "workflow", skillId: "wf-1" } },
  { label: "mcp_tool", action: { type: "mcp_tool", toolName: "zana_list_profiles", toolArgs: {} } },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — schedule_create action-object routing", () => {
  for (const { label, action } of ACTION_FIXTURES) {
    it(`routes a "${label}" action to createSchedule without coercing it to a string`, async () => {
      // createSchedule's success shape: the persisted schedule (with an id).
      mockScheduler.createSchedule.mockReturnValue({ id: `sched-${label}`, name: `s-${label}`, action });

      // Built exactly as callCore does post-fix: routing command under `_action`,
      // the schedule's `action` object as a sibling param.
      const result = await handleOrchestratorCommand(
        { _action: "schedule_create", name: `s-${label}`, every: "1h", enabled: false, action },
        null,
      );

      // Pre-fix this returned { error: "unknown action: [object Object]" }.
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ id: `sched-${label}` });

      // The action object must reach the service intact — not "[object Object]".
      expect(mockScheduler.createSchedule).toHaveBeenCalledTimes(1);
      const passed = mockScheduler.createSchedule.mock.calls[0][0];
      expect(passed.action).toEqual(action);
      expect(passed.action.type).toBe(action.type);
      // The reserved routing key must not leak into the service params.
      expect(passed._action).toBeUndefined();
    });
  }

  it("preserves an `action` param for schedule_update too (the other colliding tool)", async () => {
    const action = { type: "command", command: ["npm", "run", "build"] };
    mockScheduler.updateSchedule.mockReturnValue({ id: "s1", action });

    await handleOrchestratorCommand(
      { _action: "schedule_update", id: "s1", action, enabled: true },
      null,
    );

    expect(mockScheduler.updateSchedule).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ action, enabled: true }),
    );
    const fields = mockScheduler.updateSchedule.mock.calls[0][1];
    expect(fields.action).toEqual(action);
  });
});

describe("handleOrchestratorCommand — routing back-compat", () => {
  it("still routes a legacy command sent under `action` (no collision)", async () => {
    mockScheduler.listSchedules.mockReturnValue([{ id: "s1" }]);
    const result = await handleOrchestratorCommand({ action: "schedule_list" }, null);
    expect(mockScheduler.listSchedules).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "s1" }]);
  });

  it("routes a command sent under the reserved `_action` key", async () => {
    mockScheduler.listSchedules.mockReturnValue([]);
    await handleOrchestratorCommand({ _action: "schedule_list" }, null);
    expect(mockScheduler.listSchedules).toHaveBeenCalledTimes(1);
  });

  it("returns a readable message for a genuinely unknown command", async () => {
    const out = await handleOrchestratorCommand({ _action: "does_not_exist" }, null);
    expect(out).toEqual({ error: "unknown action: does_not_exist" });
  });
});
