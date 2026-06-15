// Focused test for the gate ORDERING inside service.claimTicket.
//
// claimTicket runs two rejection gates in sequence (service.ts ~149-162):
//   1. status gate    — `cannot claim ticket in status: <status>`
//   2. dependency gate — `ticket blocked by N open dependencies: ...`
//
// service-dependency-ordering.test.ts covers each gate in isolation, but never
// a ticket that trips BOTH at once. When a ticket is in a non-claimable status
// AND has open blockers, the status gate must win — it is evaluated first and
// returns before getOpenBlockers is ever consulted. Pinning this ordering stops
// a refactor that hoists the dependency gate above the status check from
// leaking a confusing "blocked by dependencies" error for a ticket that is
// really just in the wrong state (e.g. already in review/done).
//
// All I/O mocked; no real db, bus, clock, or network.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => []),
    listSprints: vi.fn(() => []),
    deleteTicket: vi.fn(),
    saveSprint: vi.fn(),
    getSprint: vi.fn(() => null),
    deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-claim-gate-order-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(id: string, overrides: Record<string, any> = {}) {
  fakeDb._tickets.set(id, {
    id,
    title: id,
    status: "backlog",
    priority: "medium",
    blockedBy: [],
    assigneeId: null,
    audit: [],
    comments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("claimTicket — status gate precedes dependency gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb._tickets.clear();
  });

  it("returns the status error (not the dependency error) when a ticket is both wrong-status AND dependency-blocked", () => {
    seed("DEP", { status: "in-progress" });          // an open blocker
    seed("T", { status: "review", blockedBy: ["DEP"] }); // non-claimable + blocked

    const res: any = svc.claimTicket("T", "agent-1", "Agent One");

    // Status gate wins: the message names the status, not the open dependency.
    expect(res.error).toBe("cannot claim ticket in status: review");
    expect(res.error).not.toMatch(/blocked by/);
    // The dependency-gate shape (a `blockedBy` array on the error) must be absent.
    expect(res.blockedBy).toBeUndefined();
    // Nothing was claimed.
    expect(res.ok).toBeUndefined();
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    expect(fakeBus.emit).not.toHaveBeenCalled();
  });

  it("falls through to the dependency gate only once the status gate passes (backlog + open blocker → dependency error)", () => {
    seed("DEP", { status: "in-progress" });
    seed("T", { status: "backlog", blockedBy: ["DEP"] }); // claimable status, still blocked

    const res: any = svc.claimTicket("T", "agent-1", "Agent One");

    expect(res.error).toMatch(/blocked by 1 open dependency: DEP/);
    expect(res.blockedBy).toEqual(["DEP"]);
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });
});
