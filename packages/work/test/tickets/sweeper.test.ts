// Tests for packages/work/src/tickets/sweeper.ts
//
// All dependencies are injected via _setTestSeams. We do NOT mount real
// service / db / bus modules — the sweeper test seams cover every
// outbound call. Hoisted vi.mock for @zana-ai/core only exists so the
// module's `lazyRequire` defaults don't error when the seams are reset
// to defaults at the end of each test (which never get exercised in
// these tests, but keep the require() resolvable).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  sweepOnce,
  start,
  stop,
  _setTestSeams,
  _resetTestSeams,
  _isRunning,
} from "@zana-ai/work/src/tickets/sweeper.ts";

// ── helpers ───────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

function ticket(overrides: any = {}) {
  return {
    id: "T-" + Math.random().toString(36).slice(2),
    status: "in-progress",
    assigneeId: null,
    assigneeName: null,
    audit: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildSeams(opts: {
  now: number;
  agents?: Array<{ id: string; state: string }>;
  ticketsByStatus: Record<string, any[]>;
  configEnabled?: boolean;
}) {
  const updateStatus = vi.fn(() => ({ ok: true }));
  const addComment = vi.fn(() => ({ ok: true }));
  const busEmit = vi.fn();
  const agentLister = vi.fn(() => opts.agents || []);
  const ticketLister = vi.fn((f: { status: string }) => opts.ticketsByStatus[f.status] || []);

  // Override the module-config read by patching the mocked @zana-ai/core
  // entry — but easier: the sweeper reads moduleConfig.get() lazily, and
  // the configEnabled toggle test instead drives via the test seams not
  // being reached at all when disabled. We patch via vi.mock above.
  // For the disabled case, see the dedicated test below.

  _setTestSeams({
    now: () => opts.now,
    agentLister,
    ticketLister,
    statusUpdater: updateStatus as any,
    commenter: addComment as any,
    bus: { emit: busEmit },
  });

  return { updateStatus, addComment, busEmit, agentLister, ticketLister };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  _resetTestSeams();
  stop();
});

// ── test cases ────────────────────────────────────────────────────────────

describe("sweepOnce — stale + dead assignee", () => {
  it("sweeps an in-progress ticket whose assignee is not alive and audit is older than threshold", () => {
    const now = Date.parse("2026-06-05T12:00:00.000Z");
    const stale = new Date(now - 25 * HOUR).toISOString();
    const t = ticket({
      status: "in-progress",
      assigneeId: "agent-zombie",
      assigneeName: "zombie-1",
      audit: [{ timestamp: stale }],
    });
    const { updateStatus, addComment, busEmit } = buildSeams({
      now,
      agents: [], // zombie is not in the alive set
      ticketsByStatus: { "in-progress": [t] },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment.mock.calls[0][3]).toContain("Auto-cancelled by ticket-sweeper");
    expect(addComment.mock.calls[0][3]).toContain("re-open");
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: t.id, reason: "stale-assignee-dead" });
  });
});

describe("sweepOnce — stale but assignee is alive", () => {
  it("preserves an in-progress ticket whose assignee still appears in the alive registry", () => {
    const now = Date.parse("2026-06-05T12:00:00.000Z");
    const stale = new Date(now - 25 * HOUR).toISOString();
    const t = ticket({
      status: "in-progress",
      assigneeId: "agent-alive",
      audit: [{ timestamp: stale }],
    });
    const { updateStatus, busEmit } = buildSeams({
      now,
      agents: [{ id: "agent-alive", state: "active" }],
      ticketsByStatus: { "in-progress": [t] },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });
});

describe("sweepOnce — recent activity wins", () => {
  it("preserves an in-progress ticket with audit < threshold even if assignee is dead", () => {
    const now = Date.parse("2026-06-05T12:00:00.000Z");
    const recent = new Date(now - 1 * HOUR).toISOString();
    const t = ticket({
      status: "in-progress",
      assigneeId: "agent-zombie",
      audit: [{ timestamp: recent }],
    });
    const { updateStatus, busEmit } = buildSeams({
      now,
      agents: [],
      ticketsByStatus: { "in-progress": [t] },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });
});

describe("sweepOnce — backlog is never swept", () => {
  it("does not query backlog tickets at all, regardless of age", () => {
    const now = Date.parse("2026-06-05T12:00:00.000Z");
    const t = ticket({
      status: "backlog",
      audit: [],
      createdAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    });
    const { updateStatus, busEmit, ticketLister } = buildSeams({
      now,
      ticketsByStatus: { "backlog": [t] }, // sweeper should never look here
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
    // Critical: prove the sweeper never asked for backlog rows
    const queriedStatuses = ticketLister.mock.calls.map((c) => c[0].status);
    expect(queriedStatuses).not.toContain("backlog");
  });
});

describe("sweepOnce — blocked sweeps on time alone", () => {
  it("sweeps a blocked ticket past the stale threshold even with no assignee", () => {
    const now = Date.parse("2026-06-05T12:00:00.000Z");
    const stale = new Date(now - 25 * HOUR).toISOString();
    const t = ticket({
      status: "blocked",
      assigneeId: null,
      audit: [{ timestamp: stale }],
    });
    const { updateStatus, busEmit } = buildSeams({
      now,
      ticketsByStatus: { blocked: [t] },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: t.id, reason: "stale-no-activity" });
  });
});

describe("sweepOnce — disabled via config", () => {
  it("returns zero-result and makes no outbound calls when ticketSweeperEnabled is false", () => {
    const updateStatus = vi.fn();
    const ticketLister = vi.fn(() => []);
    const busEmit = vi.fn();
    _setTestSeams({
      now: () => Date.parse("2026-06-05T12:00:00.000Z"),
      agentLister: () => [],
      ticketLister,
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
      configReader: () => ({ ticketSweeperEnabled: false }),
    });

    const result = sweepOnce();

    expect(result).toEqual({ swept: [], skipped: 0, total: 0 });
    expect(ticketLister).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });
});

describe("start / stop / _isRunning lifecycle", () => {
  it("toggles _isRunning across start and stop", () => {
    expect(_isRunning()).toBe(false);
    // Inject a no-op seam so the initial sweep doesn't depend on real modules.
    _setTestSeams({
      now: () => 0,
      agentLister: () => [],
      ticketLister: () => [],
      statusUpdater: vi.fn(() => ({ ok: true })) as any,
      commenter: vi.fn() as any,
      bus: { emit: vi.fn() },
    });
    start();
    expect(_isRunning()).toBe(true);
    stop();
    expect(_isRunning()).toBe(false);
    // Restart-cleanly check
    start();
    expect(_isRunning()).toBe(true);
    stop();
    expect(_isRunning()).toBe(false);
  });
});
