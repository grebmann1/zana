// Pins a dispatch invariant in service.ts: listReadyTickets (and therefore
// claimNextReady) only considers `backlog` and `rework` tickets. A ticket in
// status "blocked" must NEVER be dispatchable — even when it has zero OPEN
// dependency blockers — because "blocked" means a human/automation must
// intervene before work resumes. The candidate query in listReadyTickets reads
// only { status: "backlog" } + { status: "rework" }; if a regression widened it
// to include "blocked", the dependency gate would wave the ticket straight
// through (it has no open deps) and a worker would be spawned on a ticket that
// is supposed to be parked. Nothing else in the suite covers this.
//
// All I/O mocked. The fake db honors the `status` filter, matching the real
// store the ready selector relies on.

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
  config: { ZANA_DIR: "/tmp/zana-ready-blocked-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id || "T-x";
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    status: "backlog",
    priority: "medium",
    assigneeId: null,
    assigneeName: null,
    assigneeProfileId: null,
    reviewPhase: null,
    reworkCount: 0,
    sprintId: null,
    labels: [],
    blockedBy: [],
    comments: [],
    audit: [],
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("listReadyTickets excludes status:blocked", () => {
  it("omits a blocked ticket even when it has no open dependency blockers", () => {
    // No blockedBy, so the dependency gate would pass — only the candidate
    // status filter keeps it out of the ready set.
    seedTicket({ id: "PARKED", status: "blocked", blockedBy: [] });
    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual([]);
  });

  it("dispatches the backlog peer but never the blocked one", () => {
    seedTicket({ id: "PARKED", status: "blocked", priority: "critical" });
    seedTicket({ id: "GO", status: "backlog", priority: "low" });
    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["GO"]);
  });
});

describe("claimNextReady never claims a status:blocked ticket", () => {
  it("returns none_ready when the only ticket is blocked", () => {
    seedTicket({ id: "PARKED", status: "blocked", blockedBy: [] });
    const res = svc.claimNextReady("agent-1", "Agent One");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("none_ready");
    // The parked ticket must stay blocked — no claim/transition happened.
    expect(svc.getTicket("PARKED").status).toBe("blocked");
    expect(svc.getTicket("PARKED").assigneeId).toBeNull();
  });
});
