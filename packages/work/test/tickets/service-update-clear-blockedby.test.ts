// updateTicket — clearing blockedBy to [] removes the dependency gate.
//
// service-update-events.test.ts pins the SET direction ([] → ["T-other"]).
// The reverse — CLEARING an existing dependency list by passing
// `blockedBy: []` — is unpinned and is a distinct, important behavior:
//
//   service.ts updateTicket():
//     if ("blockedBy" in fields) {
//       const deps = Array.isArray(fields.blockedBy) ? fields.blockedBy : [];
//       if (deps.length > 0 && wouldCreateCycle(...)) { ... }   // skipped for []
//     }
//     ...
//     for (const key of UPDATABLE_FIELDS) if (key in fields) ticket[key] = fields[key];
//
// `blockedBy: []` is present-in-fields, so it is assigned (NOT treated as a
// no-op), the cycle check is correctly skipped (deps.length === 0), and the
// ticket's blocker list is emptied. The downstream consequence is the one that
// matters operationally: a ticket previously held back by an open dependency
// becomes claimable once its blockers are cleared. This file pins both the
// field mutation and that downstream gate effect, so a future refactor can't
// silently turn `[]` into "leave blockedBy untouched".
//
// All I/O and bus interactions are mocked — no real FS, no real bus, no clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      const all = [...tickets.values()];
      return filter?.status ? all.filter((t) => t.status === filter.status) : all;
    }),
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
  config: { ZANA_DIR: "/tmp/zana-clear-blockedby" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? `T-${Math.random().toString(36).slice(2, 8)}`;
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

describe("updateTicket — clearing blockedBy to []", () => {
  it("empties an existing blocker list and persists the cleared array", () => {
    const id = seed({ blockedBy: ["T-dep-1", "T-dep-2"] });

    const result = svc.updateTicket(id, { blockedBy: [] }, "actor") as any;

    expect(result.ok).toBe(true);
    // The empty array is assigned, NOT treated as a no-op that leaves the old list.
    expect(result.ticket.blockedBy).toEqual([]);

    const saved = fakeDb._tickets.get(id);
    expect(saved.blockedBy).toEqual([]);
    // "blockedBy" must be recorded as a changed field in the audit entry.
    const updatedEntry = saved.audit.find((a: any) => a.action === "updated");
    expect(updatedEntry.details.fields).toContain("blockedBy");
  });

  it("makes a ticket claimable once its open dependency is cleared", () => {
    // Dependency is still open (in-progress), so the dependent is blocked.
    seed({ id: "T-dep", status: "in-progress" });
    const dependentId = seed({ blockedBy: ["T-dep"] });

    // Sanity: the dependency gate refuses the claim while the blocker is open.
    const blocked = svc.claimTicket(dependentId, "agent-1", "Agent One") as any;
    expect(blocked.error).toMatch(/blocked by 1 open dependency/);

    // Clear the blocker list — the gate must now let the claim through.
    svc.updateTicket(dependentId, { blockedBy: [] }, "actor");
    const claimed = svc.claimTicket(dependentId, "agent-1", "Agent One") as any;

    expect(claimed.ok).toBe(true);
    expect(claimed.ticket.status).toBe("in-progress");
  });
});
