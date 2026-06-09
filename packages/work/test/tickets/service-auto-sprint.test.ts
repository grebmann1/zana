// Focused test for the auto-sprint attachment behavior in service.createTicket.
//
// When `sprintId` is omitted (or null/undefined), createTicket must:
//   1. Call listSprints({ status: "active" }) to discover the running sprint.
//   2. Assign that sprint's id to ticket.sprintId.
//   3. Append the new ticket id to sprint.ticketIds and persist the sprint.
//
// The happy-path tests in service.test.ts mock listSprints to return [] so
// this attachment branch is never exercised there. This file covers:
//   A. No active sprint → sprintId stays null (no crash, no side-effect).
//   B. One active sprint → ticket auto-attached, sprint.ticketIds updated.
//   C. Multiple active sprints → only the first one is used.
//   D. listSprints throws → error is swallowed, ticket still created with null sprintId.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mock objects so vi.mock factories can reference them ────────────────
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
  config: { ZANA_DIR: "/tmp/zana-auto-sprint-test" },
  project: {
    workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" },
  },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function seedSprint(overrides: Record<string, any> = {}) {
  const id = `sprint-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const sprint = {
    id,
    name: "Auto Sprint",
    status: "active",
    teamId: null,
    daemonId: null,
    ticketIds: [],
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  fakeDb._sprints.set(id, sprint);
  return sprint;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createTicket — auto-sprint attachment", () => {
  it("A. leaves sprintId null when there are no active sprints", () => {
    // listSprints returns [] (no active sprint) — sprintId must stay null.
    fakeDb.listSprints.mockReturnValue([]);
    const ticket = svc.createTicket({
      title: "No sprint",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: undefined,
      createdBy: "system",
    });
    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBeNull();
    // saveSprint must NOT have been called — no sprint to update.
    expect(fakeDb.saveSprint).not.toHaveBeenCalled();
  });

  it("B. attaches ticket to the active sprint and updates sprint.ticketIds", () => {
    const sprint = seedSprint();
    // listSprints must return the sprint with status "active" filter.
    fakeDb.listSprints.mockReturnValue([sprint]);

    const ticket = svc.createTicket({
      title: "Auto-attach me",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: undefined,
      createdBy: "bot",
    });

    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBe(sprint.id);

    // The sprint must have been updated with the new ticket id.
    const savedSprint = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(savedSprint).toBeDefined();
    expect(savedSprint.ticketIds).toContain(ticket.id);
  });

  it("C. uses only the first active sprint when multiple are returned", () => {
    const first = seedSprint({ name: "First" });
    const second = seedSprint({ name: "Second" });
    fakeDb.listSprints.mockReturnValue([first, second]);

    const ticket = svc.createTicket({
      title: "First sprint wins",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: undefined,
      createdBy: "bot",
    });

    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBe(first.id);
    // second sprint must NOT have been modified.
    const allSaveCalls = (fakeDb.saveSprint as ReturnType<typeof vi.fn>).mock.calls;
    const savedSecond = allSaveCalls.find((c) => c[0].id === second.id);
    expect(savedSecond).toBeUndefined();
  });

  it("D. swallows a listSprints error and still creates the ticket with null sprintId", () => {
    fakeDb.listSprints.mockImplementation(() => {
      throw new Error("sprints dir missing");
    });

    const ticket = svc.createTicket({
      title: "Resilient ticket",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: undefined,
      createdBy: "system",
    });

    // The error must NOT propagate — ticket is still created.
    expect(ticket.error).toBeUndefined();
    expect(ticket.id).toBeDefined();
    expect(ticket.sprintId).toBeNull();
  });

  it("explicit sprintId bypasses auto-detection entirely", () => {
    // Even when an active sprint exists, an explicit sprintId must be honoured.
    const autoSprint = seedSprint({ name: "Auto" });
    const explicitSprint = seedSprint({ name: "Explicit" });
    fakeDb.listSprints.mockReturnValue([autoSprint]);

    const ticket = svc.createTicket({
      title: "Explicit sprint",
      description: undefined,
      priority: undefined,
      labels: undefined,
      blockedBy: undefined,
      sprintId: explicitSprint.id,
      createdBy: "bot",
    });

    expect(ticket.error).toBeUndefined();
    expect(ticket.sprintId).toBe(explicitSprint.id);
    // listSprints should NOT have been called — sprintId was already provided.
    expect(fakeDb.listSprints).not.toHaveBeenCalled();
  });
});
