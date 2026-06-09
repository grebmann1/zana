// Tests for the AGENT_HOOK PostToolUse handler inside tracker.init().
//
// The _core() helper in tracker.ts uses a dynamic require() that bypasses
// vi.mock(), so handlers registered inside init() bind to the REAL event bus.
// We call vi.importActual("@zana-ai/core") to get that real bus and emit on
// it directly — the same pattern used by tracker-stats.test.ts.
//
// Covered behaviours:
//   • PostToolUse increments stats.totalToolCalls and per-agent toolCalls
//   • PostToolUse populates stats.toolBreakdown keyed by tool_name
//   • Write / Edit PostToolUse adds the file path to filesProduced exactly once
//   • Non-PostToolUse hooks are recorded as events but don't mutate tool stats
//   • filesProduced deduplicates repeated writes to the same path

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives so they're available inside vi.mock factories ──────
const { fakeBus, fakeStatsEngine, EVENTS } = vi.hoisted(() => {
  const EVENTS = {
    TEAM_STARTED: "team:started",
    TEAM_STOPPED: "team:stopped",
    AGENT_SPAWNED: "agent:spawned",
    AGENT_TERMINATED: "agent:terminated",
    AGENT_HOOK: "agent:hook",
    RUN_STARTED: "run:started",
    RUN_ENDED: "run:ended",
  };
  const fakeBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
  const fakeStatsEngine = {
    computePeakConcurrentAgents: vi.fn(() => 0),
    computeProfileBreakdown: vi.fn(() => ({})),
    computeAgentTimeline: vi.fn(() => []),
    computeTicketFlow: vi.fn(() => []),
    computeThroughput: vi.fn(() => []),
  };
  return { fakeBus, fakeStatsEngine, EVENTS };
});

vi.mock("@zana-ai/work/src/runs/store.ts", () => ({
  saveRun: vi.fn(),
  getRun: vi.fn(() => null),
  listRuns: vi.fn(() => []),
}));

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus, EVENTS, stats: fakeStatsEngine },
  config: { ZANA_DIR: "/tmp/zana-test" },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn() }) } },
}));

import * as tracker from "@zana-ai/work/src/runs/tracker.ts";

function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-hook",
    teamName: "Hook Team",
    workspace: "/ws",
    daemonId: "daemon-hook",
    orchestratorAgentId: null,
    ...overrides,
  };
}

describe("tracker — AGENT_HOOK PostToolUse tracking", () => {
  let realBus: any;

  // init() registers listeners on the real bus — call it ONCE so the handler
  // is not registered multiple times (one per beforeEach would accumulate).
  beforeAll(async () => {
    const realCore = await vi.importActual("@zana-ai/core") as any;
    realBus = realCore.events.bus;
    tracker.init();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  it("increments stats.totalToolCalls on each PostToolUse hook", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Read",
    });
    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Bash",
    });

    expect(run.stats.totalToolCalls).toBe(2);
  });

  it("populates stats.toolBreakdown keyed by tool_name", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x.ts" },
    });
    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/y.ts" },
    });
    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Read",
    });

    expect(run.stats.toolBreakdown["Write"]).toBe(2);
    expect(run.stats.toolBreakdown["Read"]).toBe(1);
  });

  it("adds file_path to filesProduced for Write tool", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      tool_input: { file_path: "/src/foo.ts" },
    });

    expect(run.filesProduced).toContain("/src/foo.ts");
    expect(run.filesProduced).toHaveLength(1);
  });

  it("adds file_path to filesProduced for Edit tool", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Edit",
      tool_input: { file_path: "/src/bar.ts" },
    });

    expect(run.filesProduced).toContain("/src/bar.ts");
  });

  it("deduplicates repeated writes to the same file path", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      tool_input: { file_path: "/src/dup.ts" },
    });
    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      tool_input: { file_path: "/src/dup.ts" },
    });

    expect(run.filesProduced.filter((p: string) => p === "/src/dup.ts")).toHaveLength(1);
  });

  it("does not add to filesProduced when tool_input has no file_path", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PostToolUse",
      agentId: "a1",
      tool_name: "Write",
      // no tool_input
    });

    expect(run.filesProduced).toHaveLength(0);
    // totalToolCalls still increments
    expect(run.stats.totalToolCalls).toBe(1);
  });

  it("ignores non-PostToolUse hook events for tool-stats purposes", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("agent:hook", {
      hook_event_name: "PreToolUse",
      agentId: "a1",
      tool_name: "Bash",
    });

    expect(run.stats.totalToolCalls).toBe(0);
    expect(Object.keys(run.stats.toolBreakdown)).toHaveLength(0);
    expect(run.filesProduced).toHaveLength(0);
  });
});
