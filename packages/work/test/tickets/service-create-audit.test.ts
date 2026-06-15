// Focused test for the "created" audit entry recorded by createTicket.
//
// service.ts:128 — addAuditEntry(ticket, "created", createdBy, { title, priority })
//
// The existing createTicket tests in service.test.ts assert the returned
// ticket's fields (title/status/priority/id) and that it is persisted, and
// service-auto-sprint.test.ts covers sprint attachment — but NOTHING asserts
// that createTicket seeds the audit trail with a "created" entry. The audit
// trail is what reconciliation and the ticket-sweeper read to reason about a
// ticket's history, so a regression that dropped this entry would pass every
// existing test. This file pins that behavior.
//
// NOTE on the event bus: service.ts emits `ticket:created` via
//   _bus() => require("@zana-ai/core").events.bus
// which resolves the real module at call time rather than the vi.mock, so a
// positive `fakeBus.emit` assertion cannot be captured here (the existing
// suite only ever asserts the *negative*). We therefore pin the audit entry,
// which is fully observable on the returned ticket and the persisted record.
//
// All I/O is mocked — no real FS, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks so vi.mock factories can reference them ─────────────────────
const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn((s: any) => { sprints.set(s.id, structuredClone(s)); }),
    getSprint: vi.fn((id: string) => (sprints.has(id) ? structuredClone(sprints.get(id)) : null)),
    // No active sprint → exercises the plain create path with no attachment.
    listSprints: vi.fn(() => []),
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
  config: { ZANA_DIR: "/tmp/zana-create-audit-test" },
  project: {
    workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" },
  },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function create(overrides: Record<string, any> = {}) {
  return svc.createTicket({
    title: "Audit me",
    description: undefined,
    priority: undefined,
    labels: undefined,
    blockedBy: undefined,
    sprintId: undefined,
    createdBy: "bob",
    ...overrides,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

// ── "created" audit entry ────────────────────────────────────────────────────

describe("createTicket — 'created' audit entry", () => {
  it("records exactly one 'created' entry with the actor and resolved title/priority", () => {
    const ticket = create({ title: "Ship it", priority: "low", createdBy: "bob" });

    const created = ticket.audit.filter((a: any) => a.action === "created");
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe("bob");
    expect(created[0].details).toEqual({ title: "Ship it", priority: "low" });
    // Every audit entry carries an id and a timestamp.
    expect(created[0].id).toBeTruthy();
    expect(created[0].timestamp).toBeTruthy();
  });

  it("records the resolved fallback priority (medium) for an invalid priority", () => {
    // The raw "urgent" input is invalid; the audit detail must carry the
    // resolved value, matching the ticket's actual priority.
    const ticket = create({ title: "Bad priority", priority: "urgent" });

    const created = ticket.audit.find((a: any) => a.action === "created");
    expect(ticket.priority).toBe("medium");
    expect(created?.details).toEqual({ title: "Bad priority", priority: "medium" });
  });

  it("falls back to actor 'system' when createdBy is omitted", () => {
    const ticket = create({ title: "No author", createdBy: undefined });

    const created = ticket.audit.find((a: any) => a.action === "created");
    expect(created?.actor).toBe("system");
  });

  it("persists the 'created' audit entry to the store", () => {
    const ticket = create({ title: "Persisted", createdBy: "ci" });

    const saved = fakeDb._tickets.get(ticket.id);
    const created = saved.audit.find((a: any) => a.action === "created");
    expect(created).toBeDefined();
    expect(created.actor).toBe("ci");
  });

  it("does not seed an audit entry when title validation fails", () => {
    const result = create({ title: "   " });

    expect(result.error).toBe("title is required");
    // A rejected create must not have persisted anything.
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });
});
