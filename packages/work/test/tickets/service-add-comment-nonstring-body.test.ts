// addComment — non-string body precondition (null / undefined / missing).
//
// The sibling service-add-comment-empty-body.test.ts pins the empty-string and
// exact-100-char boundary cases but, by its own note, deliberately leaves the
// null/undefined body unpinned. service.ts addComment() builds the comment
// record and pushes it onto ticket.comments BEFORE reaching the audit line:
//
//   src/tickets/service.ts:284
//     addAuditEntry(ticket, "commented", authorId, { body: body.slice(0, 100) });
//
// `body.slice(...)` requires a string. Per CLAUDE.md the service trusts
// internal callers and validates only at the system boundary (the MCP layer),
// so a non-string body is an out-of-contract input that throws a TypeError
// rather than being coerced. Critically, the throw happens BEFORE
// ticketStore.saveTicket / bus emit, so nothing is persisted and no event is
// fired — a half-written comment never escapes. This file pins that contract:
// a future refactor that silently coerced the body (e.g. `(body||"").slice`)
// or that moved the persist before the audit would change observable behavior
// and must be a deliberate edit, not an accident.
//
// All I/O and bus interactions are mocked — no real FS, no real bus, no clock.

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
  config: { ZANA_DIR: "/tmp/zana-add-comment-nonstring-body-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed() {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "in-progress",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("addComment — non-string body precondition", () => {
  it("throws a TypeError when the body is null", () => {
    const id = seed();
    expect(() => svc.addComment(id, "agent-1", "Alice", null as any)).toThrow(TypeError);
  });

  it("throws a TypeError when the body is undefined (omitted)", () => {
    const id = seed();
    expect(() => svc.addComment(id, "agent-1", "Alice", undefined as any)).toThrow(TypeError);
  });

  it("does not persist or emit when the body is non-string (no half-written comment escapes)", () => {
    const id = seed();
    expect(() => svc.addComment(id, "agent-1", "Alice", null as any)).toThrow();

    // The audit line throws before saveTicket / emit, so nothing is committed.
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    expect(fakeBus.emit).not.toHaveBeenCalled();
    // And the persisted ticket retains zero comments.
    const saved = fakeDb._tickets.get(id);
    expect(saved.comments).toHaveLength(0);
  });

  it("still resolves the not-found guard before touching the body (unknown ticket returns error, no throw)", () => {
    // The not-found guard runs first, so a non-string body on an unknown ticket
    // is an error result, not a TypeError — the guard short-circuits the slice.
    const res = svc.addComment("ghost-id", "agent-1", "Alice", null as any) as any;
    expect(res).toEqual({ error: "ticket not found" });
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });
});
