// Focused test for the create-time cycle guard in service.createTicket.
//
// service.ts createTicket:
//   const id = crypto.randomUUID();
//   const deps = Array.isArray(blockedBy) ? blockedBy : [];
//   if (deps.length > 0 && wouldCreateCycle(id, deps)) {
//     return { error: "blockedBy would create a dependency cycle" };
//   }
//
// The existing suite (service-dependency-ordering.test.ts) covers the happy
// path on create ("allows a valid blockedBy on create") and every cycle case on
// *update*, but never the create-time REJECTION branch. As service.ts notes,
// the only loop expressible at create is a direct self-reference — blockedBy
// containing the about-to-be-minted id — which a caller "can't construct
// without knowing the id". We make the id deterministic by mocking
// node:crypto.randomUUID, then point blockedBy at it, exercising the guard.

import { describe, it, expect, vi, beforeEach } from "vitest";

const FIXED_ID = "fixed-uuid-0000";

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

vi.mock("node:crypto", () => ({ randomUUID: () => FIXED_ID }));

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-create-cycle-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

describe("createTicket — create-time cycle rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb._tickets.clear();
  });

  it("rejects a self-referential blockedBy (the new ticket blocked by its own id)", () => {
    const res: any = svc.createTicket({
      title: "self-blocking",
      blockedBy: [FIXED_ID],
      createdBy: "tester",
    } as any);
    expect(res.error).toMatch(/dependency cycle/);
  });

  it("does not persist a ticket when the create-time cycle guard fires", () => {
    svc.createTicket({ title: "self-blocking", blockedBy: [FIXED_ID], createdBy: "tester" } as any);
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
    expect(fakeDb._tickets.size).toBe(0);
  });

  it("still creates normally when blockedBy does not close a loop (guard is cycle-specific, not a blanket block)", () => {
    // Same mocked id, but blockedBy points at an unrelated, non-self id — the
    // walk never reaches FIXED_ID, so the ticket is minted and persisted.
    const res: any = svc.createTicket({
      title: "ok",
      blockedBy: ["some-other-ticket"],
      createdBy: "tester",
    } as any);
    expect(res.error).toBeUndefined();
    // createTicket returns the ticket object directly (not wrapped).
    expect(res.id).toBe(FIXED_ID);
    expect(res.blockedBy).toEqual(["some-other-ticket"]);
    expect(fakeDb.saveTicket).toHaveBeenCalledTimes(1);
  });
});
