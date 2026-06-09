// Tests for the sprint lifecycle functions in packages/work/src/tickets/service.ts:
//   createSprint, startSprint, endSprint, getSprintBoard, addTicketToSprint.
// All storage and bus interactions are mocked — no real FS, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks ───────────────────────────────────────────────────────────────
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
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => sprints.has(id) ? structuredClone(sprints.get(id)) : null),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn((id: string) => { sprints.delete(id); }),
    _tickets: tickets,
    _sprints: sprints,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-svc-sprint-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function seedTicket(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed ticket", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  };
  fakeDb._tickets.set(id, t);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

// ── createSprint ──────────────────────────────────────────────────────────────

describe("createSprint", () => {
  it("returns a sprint with id, status=planning, and empty ticketIds by default", () => {
    const sprint = svc.createSprint({ name: "Sprint 1", teamId: "t1", daemonId: "d1", ticketIds: [] });
    expect(sprint.id).toBeDefined();
    expect(sprint.status).toBe("planning");
    expect(sprint.name).toBe("Sprint 1");
    expect(sprint.ticketIds).toEqual([]);
    expect(sprint.startedAt).toBeNull();
    expect(sprint.endedAt).toBeNull();
  });

  it("saves the sprint to the store", () => {
    svc.createSprint({ name: "S1", teamId: null, daemonId: null, ticketIds: [] });
    expect(fakeDb.saveSprint).toHaveBeenCalledOnce();
  });

  it("persists the sprint so it can be retrieved by id via the store", () => {
    const sprint = svc.createSprint({ name: "S1", teamId: "t1", daemonId: "d1", ticketIds: [] });
    // saveSprint must have been called so the store holds the object
    expect(fakeDb.saveSprint).toHaveBeenCalledOnce();
    const arg = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.id).toBe(sprint.id);
    expect(arg.name).toBe("S1");
  });

  it("backfills sprintId on member tickets when ticketIds are provided", () => {
    const id = seedTicket();
    const sprint = svc.createSprint({ name: "S2", teamId: null, daemonId: null, ticketIds: [id] });
    const saved = fakeDb.getTicket(id);
    expect(saved.sprintId).toBe(sprint.id);
  });

  it("skips missing ticketIds silently without throwing", () => {
    expect(() =>
      svc.createSprint({ name: "S3", teamId: null, daemonId: null, ticketIds: ["ghost-id"] }),
    ).not.toThrow();
  });
});

// ── startSprint ───────────────────────────────────────────────────────────────

describe("startSprint", () => {
  it("transitions status planning → active and sets startedAt", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const result = svc.startSprint(sprint.id) as any;
    expect(result.error).toBeUndefined();
    expect(result.sprint.status).toBe("active");
    expect(result.sprint.startedAt).not.toBeNull();
  });

  it("persists the updated sprint (status=active) to the store", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    vi.clearAllMocks();
    svc.startSprint(sprint.id);
    expect(fakeDb.saveSprint).toHaveBeenCalledOnce();
    const saved = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.status).toBe("active");
    expect(saved.startedAt).not.toBeNull();
  });

  it("returns error for unknown sprint id", () => {
    const result = svc.startSprint("no-such-sprint") as any;
    expect(result.error).toMatch(/sprint not found/);
  });

  it("returns error when sprint is not in planning status", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    svc.startSprint(sprint.id); // move to active
    const result = svc.startSprint(sprint.id) as any;
    expect(result.error).toMatch(/cannot start sprint/);
  });
});

// ── endSprint ─────────────────────────────────────────────────────────────────

describe("endSprint", () => {
  it("transitions status active → completed and sets endedAt", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    svc.startSprint(sprint.id);
    const result = svc.endSprint(sprint.id) as any;
    expect(result.error).toBeUndefined();
    expect(result.sprint.status).toBe("completed");
    expect(result.sprint.endedAt).not.toBeNull();
  });

  it("persists the updated sprint (status=completed) to the store", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    svc.startSprint(sprint.id);
    vi.clearAllMocks();
    svc.endSprint(sprint.id);
    expect(fakeDb.saveSprint).toHaveBeenCalledOnce();
    const saved = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.status).toBe("completed");
    expect(saved.endedAt).not.toBeNull();
  });

  it("returns error for unknown sprint id", () => {
    const result = svc.endSprint("no-such-sprint") as any;
    expect(result.error).toMatch(/sprint not found/);
  });

  it("returns error when sprint is not in active status", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    // Sprint is still in 'planning' — cannot end
    const result = svc.endSprint(sprint.id) as any;
    expect(result.error).toMatch(/cannot end sprint/);
  });
});

// ── getSprintBoard ────────────────────────────────────────────────────────────

describe("getSprintBoard", () => {
  it("returns an empty board when no tickets belong to the sprint", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const board = svc.getSprintBoard(sprint.id) as any;
    expect(board.backlog).toEqual([]);
    expect(board["in-progress"]).toEqual([]);
    expect(board.done).toEqual([]);
  });

  it("places each ticket in the column matching its status", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    seedTicket({ status: "backlog",     sprintId: sprint.id });
    seedTicket({ status: "in-progress", sprintId: sprint.id });
    seedTicket({ status: "done",        sprintId: sprint.id });

    const board = svc.getSprintBoard(sprint.id) as any;
    expect(board.backlog).toHaveLength(1);
    expect(board["in-progress"]).toHaveLength(1);
    expect(board.done).toHaveLength(1);
  });

  it("does not include tickets from other sprints", () => {
    const s1 = svc.createSprint({ name: "S1", teamId: null, daemonId: null, ticketIds: [] });
    const s2 = svc.createSprint({ name: "S2", teamId: null, daemonId: null, ticketIds: [] });
    seedTicket({ status: "backlog", sprintId: s2.id });

    const board = svc.getSprintBoard(s1.id) as any;
    expect(board.backlog).toHaveLength(0);
  });
});

// ── addTicketToSprint ─────────────────────────────────────────────────────────

describe("addTicketToSprint", () => {
  it("links the ticket to the sprint and saves both", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();
    const result = svc.addTicketToSprint(ticketId, sprint.id) as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.sprintId).toBe(sprint.id);
    expect(result.sprint.ticketIds).toContain(ticketId);
  });

  it("is idempotent — adding the same ticket twice does not duplicate the entry", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();
    svc.addTicketToSprint(ticketId, sprint.id);
    svc.addTicketToSprint(ticketId, sprint.id);
    const saved = fakeDb.getSprint(sprint.id);
    expect(saved.ticketIds.filter((id: string) => id === ticketId)).toHaveLength(1);
  });

  it("returns error when ticket is not found", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const result = svc.addTicketToSprint("ghost-ticket", sprint.id) as any;
    expect(result.error).toMatch(/ticket not found/);
  });

  it("returns error when sprint is not found", () => {
    const ticketId = seedTicket();
    const result = svc.addTicketToSprint(ticketId, "ghost-sprint") as any;
    expect(result.error).toMatch(/sprint not found/);
  });

  it("persists both the updated ticket and sprint to the store", () => {
    const sprint = svc.createSprint({ name: "S", teamId: null, daemonId: null, ticketIds: [] });
    const ticketId = seedTicket();
    vi.clearAllMocks();
    svc.addTicketToSprint(ticketId, sprint.id);
    expect(fakeDb.saveTicket).toHaveBeenCalled();
    expect(fakeDb.saveSprint).toHaveBeenCalled();
  });
});
