// Focused test for createTicket's bidirectional backfill when the caller
// passes an EXPLICIT sprintId.
//
// The auto-sprint test (service-auto-sprint.test.ts) only exercises the path
// where sprintId is omitted and the active sprint is auto-discovered via
// listSprints. When sprintId is provided explicitly, createTicket must:
//   1. NOT call listSprints (active-sprint discovery is skipped entirely).
//   2. Set ticket.sprintId to the provided id.
//   3. Backfill the named sprint's ticketIds with the new ticket id (lines
//      132-142 of service.ts) — the bidirectional link.
// And when the explicit sprintId does not resolve to a sprint, the ticket is
// still created with that sprintId and no sprint is saved.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => (sprints.has(id) ? structuredClone(sprints.get(id)) : null)),
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
  config: { ZANA_DIR: "/tmp/zana-explicit-sprint-test" },
  project: {
    workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" },
  },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedSprint(overrides: Record<string, any> = {}) {
  const id = `sprint-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const sprint = {
    id,
    name: "Explicit Sprint",
    status: "planning",
    teamId: null,
    daemonId: null,
    ticketIds: [],
    startedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  fakeDb._sprints.set(id, sprint);
  return sprint;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("createTicket — explicit sprintId backfill", () => {
  it("attaches to the named sprint, backfills ticketIds, and skips active-sprint discovery", () => {
    const sprint = seedSprint();

    const ticket = svc.createTicket({
      title: "Pinned to a specific sprint",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: sprint.id,
      createdBy: "planner",
    } as any);

    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBe(sprint.id);

    // Explicit sprintId short-circuits the active-sprint lookup.
    expect(fakeDb.listSprints).not.toHaveBeenCalled();

    // The named sprint must have been updated with the new ticket id.
    const savedSprint = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(savedSprint).toBeDefined();
    expect(savedSprint.id).toBe(sprint.id);
    expect(savedSprint.ticketIds).toContain(ticket.id);
  });

  it("creates the ticket with the given sprintId but saves no sprint when the id does not resolve", () => {
    const ticket = svc.createTicket({
      title: "Points at a missing sprint",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: "ghost-sprint",
      createdBy: "planner",
    } as any);

    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBe("ghost-sprint");
    // No sprint exists to backfill, so saveSprint must not run.
    expect(fakeDb.saveSprint).not.toHaveBeenCalled();
    // And the explicit id still bypasses active-sprint discovery.
    expect(fakeDb.listSprints).not.toHaveBeenCalled();
  });
});
