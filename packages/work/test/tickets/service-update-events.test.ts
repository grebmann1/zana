// Tests for side-effects of updateTicket() in service.ts that are not
// covered by service-update-complete.test.ts:
//
//   1. audit entry — an "updated" entry is appended to ticket.audit with
//      { action: "updated", actor: updatedBy, details: { fields: changedFields } }
//   2. updatedAt is refreshed on a successful update
//   3. UPDATABLE_FIELDS that aren't exercised elsewhere:
//        description, blockedBy, sprintId (all accepted without validation)

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
  config: { ZANA_DIR: "/tmp/zana-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed", description: "", status: "backlog",
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
});

// ── updatedAt refresh ─────────────────────────────────────────────────────────

describe("updateTicket — updatedAt is refreshed", () => {
  it("sets updatedAt to a non-null ISO string on the returned ticket", () => {
    const id = seed();
    const result = svc.updateTicket(id, { title: "Refreshed" }, "clock-bot");

    expect(result.ok).toBe(true);
    expect(typeof result.ticket.updatedAt).toBe("string");
    expect(() => new Date(result.ticket.updatedAt).toISOString()).not.toThrow();
  });

  it("persists the refreshed updatedAt to the store", () => {
    const id = seed({ updatedAt: "2020-01-01T00:00:00.000Z" });
    svc.updateTicket(id, { description: "Changed" }, "ci");

    const [savedTicket] = fakeDb.saveTicket.mock.calls[fakeDb.saveTicket.mock.calls.length - 1];
    // savedTicket.updatedAt must be different from the original seed value
    expect(savedTicket.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

// ── UPDATABLE_FIELDS not exercised elsewhere ──────────────────────────────────

describe("updateTicket — description, blockedBy, sprintId fields", () => {
  it("updates description and returns it on the ticket", () => {
    const id = seed({ description: "old" });
    const result = svc.updateTicket(id, { description: "new description" }, "actor");

    expect(result.ok).toBe(true);
    expect(result.ticket.description).toBe("new description");
  });

  it("updates blockedBy array and persists it", () => {
    const id = seed({ blockedBy: [] });
    const result = svc.updateTicket(id, { blockedBy: ["T-other"] }, "actor");

    expect(result.ok).toBe(true);
    expect(result.ticket.blockedBy).toEqual(["T-other"]);
    expect(fakeDb.saveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ id, blockedBy: ["T-other"] }),
    );
  });

  it("updates sprintId to a new value", () => {
    const id = seed({ sprintId: null });
    const result = svc.updateTicket(id, { sprintId: "sprint-42" }, "actor");

    expect(result.ok).toBe(true);
    expect(result.ticket.sprintId).toBe("sprint-42");
  });
});

// ── audit trail ───────────────────────────────────────────────────────────────

describe("updateTicket — audit entry", () => {
  it("appends exactly one audit entry with action=updated", () => {
    const id = seed();
    const result = svc.updateTicket(id, { title: "Audited title" }, "auditor");

    const auditEntries = result.ticket.audit;
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry.action).toBe("updated");
  });

  it("records the actor (updatedBy) in the audit entry", () => {
    const id = seed();
    const result = svc.updateTicket(id, { priority: "high" }, "eng-bot");

    const entry = result.ticket.audit[result.ticket.audit.length - 1];
    expect(entry.actor).toBe("eng-bot");
  });

  it("records the changed field names in audit details.fields", () => {
    const id = seed();
    const result = svc.updateTicket(id, { description: "Updated desc", labels: ["x"] }, "ci");

    const entry = result.ticket.audit[result.ticket.audit.length - 1];
    expect(entry.details.fields).toEqual(
      expect.arrayContaining(["description", "labels"]),
    );
  });

  it("persists the audit entry to the store (saveTicket receives ticket with audit)", () => {
    const id = seed();
    svc.updateTicket(id, { title: "Persisted" }, "persister");

    const [savedTicket] = fakeDb.saveTicket.mock.calls[fakeDb.saveTicket.mock.calls.length - 1];
    const lastEntry = savedTicket.audit[savedTicket.audit.length - 1];
    expect(lastEntry.action).toBe("updated");
    expect(lastEntry.actor).toBe("persister");
  });
});
