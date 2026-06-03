import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  computeOverview,
  computeToolBreakdown,
  computeProfileBreakdown,
  computeAgentTimeline,
  computeTicketFlow,
  computeThroughput,
  computePeakConcurrentAgents,
} from "../../src/events/stats-engine.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent(type: string, payload: Record<string, unknown> = {}, ts = 1000) {
  return { type, payload, timestamp: ts };
}

// ─── computeOverview ────────────────────────────────────────────────────────

describe("computeOverview", () => {
  it("returns all-zero overview for empty input", () => {
    const result = computeOverview([]);
    expect(result).toEqual({
      totalAgents: 0,
      totalToolCalls: 0,
      ticketsCreated: 0,
      ticketsCompleted: 0,
      ticketCompletionRate: 0,
      eventCount: 0,
    });
  });

  it("counts distinct agentIds from agent:spawned events", () => {
    const events = [
      makeEvent("agent:spawned", { agentId: "a1" }),
      makeEvent("agent:spawned", { agentId: "a2" }),
      makeEvent("agent:spawned", { agentId: "a1" }), // duplicate — same agent
    ];
    expect(computeOverview(events).totalAgents).toBe(2);
  });

  it("counts only PostToolUse hooks as tool calls", () => {
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse" }),
      makeEvent("agent:hook", { hook_event_name: "PreToolUse" }), // not counted
      makeEvent("agent:hook", { hook_event_name: "PostToolUse" }),
    ];
    expect(computeOverview(events).totalToolCalls).toBe(2);
  });

  it("computes ticketCompletionRate as completed / created", () => {
    const events = [
      makeEvent("ticket:created"),
      makeEvent("ticket:created"),
      makeEvent("ticket:created"),
      makeEvent("ticket:completed"),
    ];
    const ov = computeOverview(events);
    expect(ov.ticketsCreated).toBe(3);
    expect(ov.ticketsCompleted).toBe(1);
    expect(ov.ticketCompletionRate).toBeCloseTo(1 / 3);
  });

  it("ticketCompletionRate is 0 when no tickets created", () => {
    expect(computeOverview([]).ticketCompletionRate).toBe(0);
  });

  it("eventCount reflects total number of events regardless of type", () => {
    const events = [makeEvent("unknown:type"), makeEvent("agent:spawned", { agentId: "x" })];
    expect(computeOverview(events).eventCount).toBe(2);
  });
});

// ─── computeToolBreakdown ────────────────────────────────────────────────────

describe("computeToolBreakdown", () => {
  it("returns empty object for no events", () => {
    expect(computeToolBreakdown([])).toEqual({});
  });

  it("tallies tool_name from PostToolUse hooks", () => {
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Read" }),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Read" }),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Bash" }),
      makeEvent("agent:hook", { hook_event_name: "PreToolUse", tool_name: "Read" }), // ignored
    ];
    expect(computeToolBreakdown(events)).toEqual({ Read: 2, Bash: 1 });
  });

  it("buckets missing tool_name under 'unknown'", () => {
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse" }), // no tool_name
    ];
    expect(computeToolBreakdown(events)).toEqual({ unknown: 1 });
  });
});

// ─── computeProfileBreakdown ─────────────────────────────────────────────────

describe("computeProfileBreakdown", () => {
  it("returns empty object for no events", () => {
    expect(computeProfileBreakdown([])).toEqual({});
  });

  it("tallies profileId from agent:spawned events", () => {
    const events = [
      makeEvent("agent:spawned", { agentId: "a1", profileId: "coder" }),
      makeEvent("agent:spawned", { agentId: "a2", profileId: "coder" }),
      makeEvent("agent:spawned", { agentId: "a3", profileId: "reviewer" }),
    ];
    expect(computeProfileBreakdown(events)).toEqual({ coder: 2, reviewer: 1 });
  });

  it("buckets missing profileId under 'unknown'", () => {
    const events = [makeEvent("agent:spawned", { agentId: "a1" })];
    expect(computeProfileBreakdown(events)).toEqual({ unknown: 1 });
  });
});

// ─── computeAgentTimeline ────────────────────────────────────────────────────
//
// NOTE: computeAgentTimeline calls Date.now() for the bucket end-time:
//   const end = Math.max(events[last].timestamp, Date.now())
// Tests that use small synthetic timestamps MUST freeze Date.now() or the loop
// will iterate (Date.now() - 0) / bucketMs ≈ 1.75 billion times and OOM.

describe("computeAgentTimeline", () => {
  // Freeze time at a fixed epoch so Date.now() is bounded in every test here.
  const FROZEN_NOW = 5_000; // 5 seconds — comfortably above all test timestamps
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FROZEN_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns empty array for no events", () => {
    expect(computeAgentTimeline([])).toEqual([]);
  });

  it("returns empty array when no agent:spawned events exist", () => {
    const events = [makeEvent("ticket:created", {}, 1000)];
    expect(computeAgentTimeline(events)).toEqual([]);
  });

  it("produces buckets with active-agent count that goes up on spawn and down on termination", () => {
    const bucketMs = 1000;
    const events = [
      { type: "agent:spawned",    payload: { agentId: "a1" }, timestamp: 0 },
      { type: "agent:spawned",    payload: { agentId: "a2" }, timestamp: 0 },
      { type: "agent:terminated", payload: { agentId: "a1" }, timestamp: 1000 },
    ];
    const buckets = computeAgentTimeline(events, bucketMs);
    // First bucket (ts=0): 2 spawned, 0 terminated → count 2
    expect(buckets[0].count).toBe(2);
    // Second bucket (ts=1000): 2 spawned, 1 terminated → count 1
    const secondBucket = buckets.find((b: { ts: number }) => b.ts === 1000);
    expect(secondBucket?.count).toBe(1);
  });

  it("count never goes negative even with excess terminations", () => {
    const events = [
      { type: "agent:spawned",    payload: { agentId: "a1" }, timestamp: 0 },
      { type: "agent:terminated", payload: { agentId: "a1" }, timestamp: 0 },
      { type: "agent:terminated", payload: { agentId: "a1" }, timestamp: 0 }, // extra
    ];
    const buckets = computeAgentTimeline(events, 1000);
    for (const b of buckets) {
      expect(b.count).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── computeTicketFlow ───────────────────────────────────────────────────────

describe("computeTicketFlow", () => {
  it("returns empty array for no events", () => {
    expect(computeTicketFlow([])).toEqual([]);
  });

  it("ignores non-ticket events", () => {
    expect(computeTicketFlow([makeEvent("agent:spawned", { agentId: "a" })])).toEqual([]);
  });

  it("builds cumulative created/completed series in event order", () => {
    const events = [
      { type: "ticket:created",   timestamp: 100 },
      { type: "ticket:created",   timestamp: 200 },
      { type: "ticket:completed", timestamp: 300 },
    ];
    const flow = computeTicketFlow(events);
    expect(flow).toHaveLength(3);
    expect(flow[0]).toMatchObject({ ts: 100, created: 1, completed: 0 });
    expect(flow[1]).toMatchObject({ ts: 200, created: 2, completed: 0 });
    expect(flow[2]).toMatchObject({ ts: 300, created: 2, completed: 1 });
  });
});

// ─── computeThroughput ───────────────────────────────────────────────────────

describe("computeThroughput", () => {
  it("returns empty array for no events", () => {
    expect(computeThroughput([])).toEqual([]);
  });

  it("returns empty array when no PostToolUse events", () => {
    expect(computeThroughput([makeEvent("agent:spawned", { agentId: "x" })])).toEqual([]);
  });

  it("buckets tool calls by time window", () => {
    const bucketMs = 1000;
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Read" }, 0),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Bash" }, 500),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Edit" }, 1000),
    ];
    const buckets = computeThroughput(events, bucketMs);
    // Bucket [0, 1000): 2 calls
    expect(buckets[0]).toMatchObject({ ts: 0, count: 2 });
    // Bucket [1000, 2000): 1 call
    expect(buckets[1]).toMatchObject({ ts: 1000, count: 1 });
  });
});

// ─── computePeakConcurrentAgents ─────────────────────────────────────────────

describe("computePeakConcurrentAgents", () => {
  it("returns 0 for empty input", () => {
    expect(computePeakConcurrentAgents([])).toBe(0);
  });

  it("tracks spawns and terminations in order to find peak", () => {
    const events = [
      makeEvent("agent:spawned"),    // current=1, peak=1
      makeEvent("agent:spawned"),    // current=2, peak=2
      makeEvent("agent:spawned"),    // current=3, peak=3
      makeEvent("agent:terminated"), // current=2
      makeEvent("agent:spawned"),    // current=3, peak still 3
      makeEvent("agent:terminated"), // current=2
      makeEvent("agent:terminated"), // current=1
    ];
    expect(computePeakConcurrentAgents(events)).toBe(3);
  });

  it("never decrements current below 0", () => {
    const events = [
      makeEvent("agent:terminated"), // spurious — no prior spawn
      makeEvent("agent:terminated"),
    ];
    expect(computePeakConcurrentAgents(events)).toBe(0);
  });
});
