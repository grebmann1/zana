// claimTicket dependency gate — partial-closure invariant.
//
// packages/work/src/tickets/service.ts claimTicket():
//   const openBlockers = getOpenBlockers(ticket);
//   if (openBlockers.length > 0) {
//     return {
//       error: `ticket blocked by ${openBlockers.length} open ...: ${openBlockers.join(", ")}`,
//       blockedBy: openBlockers,
//     };
//   }
//
// Sibling tests already cover the all-open case (one or many blockers) and the
// all-closed case (claim succeeds). What none of them pin is the MIX: a ticket
// whose blockedBy contains BOTH terminal (done/cancelled) and still-open
// dependencies. The rejection must report ONLY the open blockers — both in the
// count/message and in the returned `blockedBy` array — because the gate is
// derived from getOpenBlockers, not the raw ticket.blockedBy list.
//
// A refactor that accidentally surfaced the raw blockedBy array (or its length)
// would satisfy every existing claim test yet leak resolved dependencies into
// the error. This file pins the open-only contract at the claimTicket level.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks ────────────────────────────────────────────────────────────────
const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const sprints = new Map<string, any>();

  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter((t) => t.status === filter.status);
      if (filter?.sprintId) all = all.filter((t) => t.sprintId === filter.sprintId);
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
  config: { ZANA_DIR: "/tmp/zana-claim-mixed-blockers" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ────────────────────────────────────────────────────────────────────
function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id || `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = "2026-01-01T00:00:00.000Z";
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
    createdAt: now,
    updatedAt: now,
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

// ── partial-closure invariant ───────────────────────────────────────────────────
describe("claimTicket — mixed open/closed blockers report only the open ones", () => {
  it("excludes done and cancelled blockers from the rejection, leaving a singular error", () => {
    // Two resolved deps + exactly one open dep. The error must name only the
    // open dep and use the SINGULAR wording — proving the count is derived from
    // open blockers, not the raw 3-entry blockedBy list.
    seedTicket({ id: "DONE-DEP", status: "done" });
    seedTicket({ id: "CANCELLED-DEP", status: "cancelled" });
    seedTicket({ id: "OPEN-DEP", status: "in-progress" });
    const id = seedTicket({ blockedBy: ["DONE-DEP", "CANCELLED-DEP", "OPEN-DEP"] });

    const res = svc.claimTicket(id, "agent-1", "Agent One");

    expect(res.ok).toBeUndefined();
    // Open-only: count is 1 (not 3), wording is singular, only OPEN-DEP listed.
    expect(res.error).toBe("ticket blocked by 1 open dependency: OPEN-DEP");
    expect(res.error).not.toMatch(/DONE-DEP|CANCELLED-DEP/);
    expect(res.blockedBy).toEqual(["OPEN-DEP"]);
    // The ticket must remain unclaimed.
    expect(fakeDb._tickets.get(id).status).toBe("backlog");
    expect(fakeDb._tickets.get(id).assigneeId).toBeNull();
    expect(fakeBus.emit).not.toHaveBeenCalledWith("ticket:claimed", expect.anything());
  });

  it("preserves blockedBy order when several deps are open and one is resolved", () => {
    // First dep resolved, two later deps open: the error lists the two open
    // ones in their original blockedBy order and uses the plural wording.
    seedTicket({ id: "RESOLVED", status: "done" });
    seedTicket({ id: "OPEN-A", status: "review" });
    seedTicket({ id: "OPEN-B", status: "backlog" });
    const id = seedTicket({ blockedBy: ["RESOLVED", "OPEN-A", "OPEN-B"] });

    const res = svc.claimTicket(id, "agent-1");

    expect(res.error).toBe("ticket blocked by 2 open dependencies: OPEN-A, OPEN-B");
    expect(res.blockedBy).toEqual(["OPEN-A", "OPEN-B"]);
  });
});
