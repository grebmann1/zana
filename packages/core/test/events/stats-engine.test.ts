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

  // Every test above isolates a single field. This pins the single-pass switch
  // (stats-engine.ts) accumulating ALL counters at once from one interleaved
  // stream — distinct agents (with a duplicate), only PostToolUse hooks counted,
  // ticket created/completed tallies, and an unrelated event that touches no
  // counter but still bumps eventCount. Guards against cross-case interference.
  it("accumulates every counter simultaneously from a mixed, interleaved stream", () => {
    const events = [
      makeEvent("agent:spawned", { agentId: "a1" }),
      makeEvent("ticket:created"),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse" }),
      makeEvent("agent:hook", { hook_event_name: "PreToolUse" }), // not a tool call
      makeEvent("agent:spawned", { agentId: "a2" }),
      makeEvent("ticket:created"),
      makeEvent("agent:spawned", { agentId: "a1" }), // duplicate agent
      makeEvent("ticket:completed"),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse" }),
      makeEvent("noise:event"), // affects only eventCount
    ];
    expect(computeOverview(events)).toEqual({
      totalAgents: 2,
      totalToolCalls: 2,
      ticketsCreated: 2,
      ticketsCompleted: 1,
      ticketCompletionRate: 1 / 2,
      eventCount: 10,
    });
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

  // stats-engine.ts sets `end = Math.max(events[last].timestamp, Date.now())`,
  // so the bucket loop runs from the first spawn up to *now* — not merely up to
  // the last event. After every agent has terminated, the timeline must keep
  // emitting trailing zero-count buckets out to the frozen clock. The existing
  // tests freeze time but only `.find()` individual buckets; none pin the
  // timeline EXTENT or that it extends past the last event to Date.now().
  it("extends buckets to Date.now() with trailing zero-count buckets after all agents terminate", () => {
    const bucketMs = 1000;
    // FROZEN_NOW = 5000; last event at 1000 → end = max(1000, 5000) = 5000.
    const events = [
      { type: "agent:spawned",    payload: { agentId: "a1" }, timestamp: 0 },
      { type: "agent:terminated", payload: { agentId: "a1" }, timestamp: 1000 },
    ];
    const buckets = computeAgentTimeline(events, bucketMs);
    // start=0, end=5000, step=1000 → 6 buckets (inclusive of end).
    expect(buckets.map((b: { ts: number; count: number }) => b)).toEqual([
      { ts: 0, count: 1 },    // a1 active
      { ts: 1000, count: 0 }, // a1 terminated
      { ts: 2000, count: 0 }, // trailing — driven by Date.now(), not last event
      { ts: 3000, count: 0 },
      { ts: 4000, count: 0 },
      { ts: 5000, count: 0 },
    ]);
  });

  // Complement to the test above. `end = Math.max(events[last].timestamp,
  // Date.now())` has two sides: the prior test pins the Date.now() side (last
  // event 1000 < frozen now 5000). This pins the OTHER side — when the LAST
  // event is a non-agent event whose timestamp exceeds Date.now(), it (not the
  // clock) drives the timeline extent. `events[last]` is taken regardless of
  // type, so a trailing ticket:created at ts=8000 (> FROZEN_NOW=5000) must
  // stretch the buckets out to 8000, all trailing buckets zero after a1 ends.
  it("extends buckets to the last event's timestamp when it exceeds Date.now() (any event type)", () => {
    const bucketMs = 1000;
    const events = [
      { type: "agent:spawned",    payload: { agentId: "a1" }, timestamp: 0 },
      { type: "agent:terminated", payload: { agentId: "a1" }, timestamp: 1000 },
      { type: "ticket:created",   payload: {},               timestamp: 8000 }, // last; not a spawn/term
    ];
    const buckets = computeAgentTimeline(events, bucketMs);
    // start=0, end=max(8000, 5000)=8000, step=1000 → 9 buckets (inclusive).
    expect(buckets).toHaveLength(9);
    expect(buckets[0]).toEqual({ ts: 0, count: 1 });    // a1 active
    expect(buckets[buckets.length - 1].ts).toBe(8000);  // extent driven by last event, not clock
    // every bucket from termination onward is zero
    for (const b of buckets.slice(1)) expect(b.count).toBe(0);
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

  // An idle gap between tool calls must surface as zero-count intermediate
  // buckets, not collapse the series — otherwise throughput charts would
  // misrepresent quiet periods as contiguous activity. The loop runs
  // `ts <= end` stepping by bucketMs from the first to the last tool event,
  // so a 3000ms span at 1000ms buckets yields 4 buckets with the middle two
  // empty. The existing suite only exercises back-to-back buckets, leaving
  // this gap-preservation behavior untested.
  it("emits zero-count buckets for idle gaps between tool calls", () => {
    const bucketMs = 1000;
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Read" }, 0),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Edit" }, 3000),
    ];
    const buckets = computeThroughput(events, bucketMs);
    expect(buckets).toEqual([
      { ts: 0, count: 1 },
      { ts: 1000, count: 0 },
      { ts: 2000, count: 0 },
      { ts: 3000, count: 1 },
    ]);
  });

  // Degenerate single-window case: when every PostToolUse event shares one
  // timestamp, start === end, so the `ts <= end` loop body runs exactly once
  // and must emit a SINGLE bucket tallying all of them — not zero buckets (a
  // `<` bound would skip the only window) and not one-bucket-per-event. The
  // existing suite only exercises multi-bucket spans and idle gaps, leaving
  // this start===end boundary of the loop untested.
  it("collapses tool calls sharing one timestamp into a single bucket", () => {
    const bucketMs = 1000;
    const events = [
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Read" }, 2000),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Bash" }, 2000),
      makeEvent("agent:hook", { hook_event_name: "PostToolUse", tool_name: "Edit" }, 2000),
    ];
    const buckets = computeThroughput(events, bucketMs);
    // start = end = 2000 → loop runs once → exactly one bucket holding all 3.
    expect(buckets).toEqual([{ ts: 2000, count: 3 }]);
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

  // A later concurrency wave that exceeds an earlier one must raise the peak.
  // The first burst peaks at 2, fully drains, then a second burst reaches 3.
  // Pins the `if (current > peak) peak = current` re-update across waves —
  // the existing suite only checks a single burst and a re-tie at the same
  // peak, never a later wave climbing ABOVE the earlier high-water mark.
  it("raises the peak when a later wave exceeds an earlier peak", () => {
    const events = [
      makeEvent("agent:spawned"),    // current=1, peak=1
      makeEvent("agent:spawned"),    // current=2, peak=2
      makeEvent("agent:terminated"), // current=1
      makeEvent("agent:terminated"), // current=0 — first wave drained
      makeEvent("agent:spawned"),    // current=1
      makeEvent("agent:spawned"),    // current=2
      makeEvent("agent:spawned"),    // current=3, peak=3 — exceeds earlier
    ];
    expect(computePeakConcurrentAgents(events)).toBe(3);
  });
});
