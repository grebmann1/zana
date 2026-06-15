// getSprintBoard — silent-drop invariant for unknown statuses.
//
// packages/work/src/tickets/service.ts lines 268-274:
//   for (const ticket of tickets) {
//     if (board[ticket.status]) {         // ← key guard
//       board[ticket.status].push(ticket);
//     }
//   }                                    // tickets with unknown status are silently dropped
//
// The board object has exactly six fixed columns:
//   backlog | in-progress | review | rework | blocked | done
//
// Any ticket whose status is not one of those six (e.g. a legacy record with
// a custom status, a migration artefact, or a value set outside the
// ALLOWED_STATUSES path) is silently dropped from the board rather than
// causing an error. This file pins that contract so a future refactor cannot
// accidentally convert the silent-drop into a throw, a null entry, or an
// unexpected extra column.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks ────────────────────────────────────────────────────────────────

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      const all = [...tickets.values()];
      if (!filter) return all;
      return all.filter((t) => !filter.sprintId || t.sprintId === filter.sprintId);
    }),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn(),
    _tickets: tickets,
    _sprints: sprints,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-board-unknown-status" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import { getSprintBoard } from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

const SPRINT_ID = "sprint-board-test";

function seedTicket(status: string, sprintId = SPRINT_ID) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Test ticket", status, sprintId,
    priority: "medium", labels: [], comments: [], audit: [],
    createdAt: now, updatedAt: now,
  });
  return id;
}

const STANDARD_STATUSES = ["backlog", "in-progress", "review", "rework", "blocked", "done"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

// ── silent-drop invariant ─────────────────────────────────────────────────────

describe("getSprintBoard — unknown status is silently dropped", () => {
  it("does not throw when a ticket has an unknown status", () => {
    seedTicket("legacy-status");
    expect(() => getSprintBoard(SPRINT_ID)).not.toThrow();
  });

  it("drops the unknown-status ticket — no column in the board contains it", () => {
    seedTicket("custom-unknown-status");
    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    const allTickets = Object.values(board).flat();
    expect(allTickets).toHaveLength(0);
  });

  it("drops unknown-status ticket while still listing known-status tickets", () => {
    // One valid ticket + one with an unknown status in the same sprint.
    // The valid one must appear; the unknown must be silently dropped.
    const validId = seedTicket("done");
    seedTicket("not-a-real-status");

    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    expect(board.done).toHaveLength(1);
    expect(board.done[0].id).toBe(validId);
    const allTickets = Object.values(board).flat();
    expect(allTickets).toHaveLength(1); // only the valid one
  });

  it("handles empty-string status without throwing and drops the ticket", () => {
    seedTicket("");
    expect(() => getSprintBoard(SPRINT_ID)).not.toThrow();
    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    expect(Object.values(board).flat()).toHaveLength(0);
  });

  it("drops a 'cancelled' ticket even though it is a valid status — the board has no cancelled column", () => {
    // "cancelled" is a member of VALID_STATUSES (service.ts), yet the board
    // object exposes only six columns and 'cancelled' is deliberately not one
    // of them. So a legitimately cancelled ticket is silently dropped, not an
    // error and not an extra column. This pins that real-status edge, which the
    // fictional-status cases above do not exercise.
    const doneId = seedTicket("done");
    seedTicket("cancelled");

    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    expect(board).not.toHaveProperty("cancelled");
    expect(Object.keys(board)).toHaveLength(STANDARD_STATUSES.length);
    // Only the done ticket survives; the cancelled one is dropped.
    const allTickets = Object.values(board).flat();
    expect(allTickets).toHaveLength(1);
    expect(board.done[0].id).toBe(doneId);
  });
});

// ── board shape invariant ─────────────────────────────────────────────────────

describe("getSprintBoard — board always has exactly the six standard columns", () => {
  it("returns all six columns when the sprint has no tickets", () => {
    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    for (const col of STANDARD_STATUSES) {
      expect(board, `missing column '${col}'`).toHaveProperty(col);
      expect(Array.isArray(board[col]), `column '${col}' must be an array`).toBe(true);
    }
    expect(Object.keys(board)).toHaveLength(STANDARD_STATUSES.length);
  });

  it("returns all six columns even when only one column has tickets", () => {
    seedTicket("review");
    const board = getSprintBoard(SPRINT_ID) as Record<string, any[]>;
    for (const col of STANDARD_STATUSES) {
      expect(board).toHaveProperty(col);
    }
    expect(board.review).toHaveLength(1);
    // All other columns must still be present and empty.
    for (const col of STANDARD_STATUSES.filter((c) => c !== "review")) {
      expect(board[col]).toHaveLength(0);
    }
  });
});
