// updateTicket — input-guard for a non-object `fields` argument.
//
// service.ts updateTicket() guards its second argument:
//
//   if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
//     return { error: "no fields provided" };
//   }
//
// service-update-complete.test.ts already pins the empty-object case ({} →
// Object.keys().length === 0). It does NOT pin the other two branches:
//   - `!fields`                  → null / undefined
//   - `typeof fields !== "object"` → string / number / boolean
//
// All of these must return { error: "no fields provided" } WITHOUT throwing,
// WITHOUT mutating the ticket, and WITHOUT emitting a bus event — the guard runs
// before any write. The ticket-not-found check precedes the guard, so we seed a
// real ticket first to be sure we are exercising the fields-guard, not the
// existence check. This file pins those branches so a refactor that narrows the
// guard to only `{}` (a common simplification) cannot silently let a malformed
// call through.
//
// All I/O and bus interactions are mocked — no real FS, no real bus.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
    saveSprint: vi.fn(),
    getSprint: vi.fn(() => null),
    listSprints: vi.fn(() => []),
    deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-update-nonobject-guard-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("updateTicket — rejects a non-object `fields` argument", () => {
  // Each value below trips a DIFFERENT clause of the guard:
  //   null / undefined → `!fields`
  //   "title" / 5 / true → `typeof fields !== "object"`
  const cases: Array<[string, any]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "title"],
    ["a number", 5],
    ["a boolean", true],
  ];

  for (const [label, value] of cases) {
    it(`returns "no fields provided" when fields is ${label}`, () => {
      const id = seed();
      const result = svc.updateTicket(id, value as any, "actor") as any;
      expect(result.error).toBe("no fields provided");
      expect(result.ok).toBeUndefined();
    });
  }

  it("does not mutate the ticket or emit an event on the guard rejection", () => {
    const id = seed({ title: "Untouched" });

    svc.updateTicket(id, null as any, "actor");

    // Store write never happened — the guard returns before saveTicket.
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    // And no ticket:updated event was emitted.
    expect(fakeBus.emit).not.toHaveBeenCalled();
    // The persisted ticket is byte-for-byte unchanged.
    const saved = fakeDb._tickets.get(id);
    expect(saved.title).toBe("Untouched");
    expect(saved.audit).toHaveLength(0);
  });
});
