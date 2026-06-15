// Focused test for the documented invariant in service.ts:
//   "Unknown priorities sort as 'medium'." (PRIORITY_RANK[...] ?? medium)
//
// The existing service-dependency-ordering.test.ts exercises listReadyTickets
// ordering only with the four VALID_PRIORITIES. This pins the fallback: a
// ticket carrying an unrecognized priority string must dispatch in the medium
// band (rank 2) and tie-break against real medium tickets purely by age.
//
// All I/O mocked — no real db, bus, or workspace.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter(t => t.status === filter.status);
      if (filter?.sprintId) all = all.filter(t => t.sprintId === filter.sprintId);
      return all.map((t) => structuredClone(t));
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
  config: { ZANA_DIR: "/tmp/zana-ready-prio-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

let seq = 0;
function seedTicket(overrides: Record<string, any> = {}) {
  seq += 1;
  const id = overrides.id || `T-${seq}`;
  const createdAt = overrides.createdAt || `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
  fakeDb._tickets.set(id, {
    id,
    title: `Ticket ${id}`,
    status: "backlog",
    priority: "medium",
    sprintId: null,
    blockedBy: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  seq = 0;
});

describe("listReadyTickets — unknown priority fallback", () => {
  it("sorts an unrecognized priority in the medium band, tie-broken by age", () => {
    // createdAt is monotonic with seq order below.
    seedTicket({ id: "critical", priority: "critical" });   // rank 0
    seedTicket({ id: "medium-early", priority: "medium" });  // rank 2, oldest medium
    seedTicket({ id: "bogus", priority: "urgent" });         // unknown → rank 2 (medium)
    seedTicket({ id: "medium-late", priority: "medium" });   // rank 2, newest medium
    seedTicket({ id: "low", priority: "low" });              // rank 3

    const ready = svc.listReadyTickets();

    // critical first, low last; the unknown-priority ticket lands strictly
    // inside the medium band ordered by age (medium-early < bogus < medium-late).
    expect(ready.map((t: any) => t.id)).toEqual([
      "critical",
      "medium-early",
      "bogus",
      "medium-late",
      "low",
    ]);
  });
});
