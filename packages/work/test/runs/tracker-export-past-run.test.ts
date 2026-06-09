// Tests the `exportRun` ndjson path for a **past (non-current) run**.
//
// `exportRun` in tracker.ts has an `isCurrentRun` branch (lines 235-236):
//   const isCurrentRun = currentRun && currentRun.id === runId;
//   const events = isCurrentRun ? runEvents : [];
//
// All existing ndjson tests start a run but never end it, so `isCurrentRun`
// is always true and `events` always contains in-memory entries.
// This file exercises the `isCurrentRun === false` path (ended run returned
// from the store) where events is `[]` and the ndjson output contains exactly
// one line (the run header) — no event lines.
//
// Also verifies that the same past-run path generates a correct `.json` export
// (the run-object-only shape without an events array element mismatch).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives ────────────────────────────────────────────────────
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
import * as store from "@zana-ai/work/src/runs/store.ts";

function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-past",
    teamName: "Past Team",
    workspace: "/ws",
    daemonId: "daemon-past",
    orchestratorAgentId: null,
    ...overrides,
  };
}

describe("tracker — exportRun for a past (non-current) run", () => {
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

  it("ndjson export of a past run contains exactly one line (run header only, no events)", () => {
    // Start and immediately end a run so it is no longer the current run.
    const run = tracker.startRun(makeRunArgs({ teamId: "t-past-ndjson" }));
    tracker.endRun(run.id);

    // Simulate the store returning this past run by id.
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(run);

    // currentRun is now null — this run is a past run in the store.
    expect(tracker.getCurrentRun()).toBeNull();

    const result = tracker.exportRun(run.id, "ndjson");

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/\.ndjson$/);

    // Strip trailing newline and split into lines.
    const lines = result!.data.replace(/\n$/, "").split("\n");

    // Exactly ONE line — the run header; no event lines because events = [] for
    // a non-current run.
    expect(lines).toHaveLength(1);

    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("run");
    expect(header.data.id).toBe(run.id);
  });

  it("ndjson data for a past run ends with a trailing newline", () => {
    const run = tracker.startRun(makeRunArgs({ teamId: "t-past-newline" }));
    tracker.endRun(run.id);
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(run);

    const result = tracker.exportRun(run.id, "ndjson");
    expect(result!.data.endsWith("\n")).toBe(true);
  });

  it("json export of a past run includes an empty events array", () => {
    const run = tracker.startRun(makeRunArgs({ teamId: "t-past-json" }));
    tracker.endRun(run.id);
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(run);

    const result = tracker.exportRun(run.id); // default format="json"
    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/\.json$/);

    const parsed = JSON.parse(result!.data);
    expect(parsed.run.id).toBe(run.id);
    // events must be present and empty — past run has no in-memory event log.
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(0);
  });
});
