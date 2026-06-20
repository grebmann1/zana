// Focused test for sweeper.ts start() initial-sweep behavior.
//
// start() documents (sweeper.ts:213) that it runs ONE sweep immediately so a
// backlog stranded by a prior daemon run gets cleared promptly — before the
// interval timer ever fires. The existing lifecycle test only asserts that
// _isRunning() toggles; it never proves the initial sweep actually ran. This
// test pins that behavior: a stale, dead-assignee ticket present at start()
// time must be cancelled synchronously during start(), with no fake timers
// advanced.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  start,
  stop,
  _setTestSeams,
  _resetTestSeams,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-09T10:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("start() — initial immediate sweep", () => {
  it("sweeps a stale dead-assignee ticket synchronously on start(), before any interval tick", () => {
    const staleAt = new Date(FIXED_NOW - 25 * HOUR).toISOString();
    const t = {
      id: "T-initial-sweep",
      status: "in-progress",
      assigneeId: "agent-dead",
      assigneeName: "dead-agent",
      audit: [{ timestamp: staleAt }],
      createdAt: staleAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [], // assignee not alive
      ticketLister: (f: { status: string }) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
      // Long interval so the only sweep that can run here is the initial one.
      configReader: () => ({ ticketSweeperIntervalMs: 60 * 60 * 1000 }),
    });

    // No fake timers, no clock advance — the sweep must happen inside start().
    const stopFn = start();

    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: t.id, reason: "stale-assignee-dead" }),
    );

    stopFn();
  });
});
