// Focused test for the null-safety guard in service.getOpenBlockers.
//
// service.ts line 21:
//   const deps = Array.isArray(ticket?.blockedBy) ? ticket.blockedBy : [];
//
// The `ticket?.` optional chain exists so the function never throws when handed
// a nullish ticket (e.g. a caller that fetched getTicket() and got null, then
// forwarded the result without a guard). The existing suite
// (service-dependency-ordering.test.ts) covers `{blockedBy:[]}` and `{}` but
// never a null/undefined ticket, nor a non-array blockedBy. This file pins the
// defensive contract: nullish / malformed input yields an empty blocker list,
// never a throw.

import { describe, it, expect, vi } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn(),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => []),
    deleteTicket: vi.fn(),
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
  config: { ZANA_DIR: "/tmp/zana-open-blockers-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

describe("getOpenBlockers — nullish / malformed ticket", () => {
  it("returns [] for a null ticket without throwing", () => {
    expect(svc.getOpenBlockers(null)).toEqual([]);
  });

  it("returns [] for an undefined ticket without throwing", () => {
    expect(svc.getOpenBlockers(undefined)).toEqual([]);
  });

  it("returns [] when blockedBy is not an array (e.g. a string)", () => {
    // A malformed record where blockedBy was persisted as a scalar must not be
    // iterated — the Array.isArray guard coerces it to an empty dep list.
    expect(svc.getOpenBlockers({ blockedBy: "T-1" as any })).toEqual([]);
  });

  it("never consults the store for a nullish ticket (no dep walk attempted)", () => {
    fakeDb.getTicket.mockClear();
    svc.getOpenBlockers(null);
    expect(fakeDb.getTicket).not.toHaveBeenCalled();
  });
});
