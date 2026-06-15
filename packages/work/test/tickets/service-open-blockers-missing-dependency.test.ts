// Focused test for the missing-dependency invariant in service.getOpenBlockers.
//
// service.ts lines 11-29:
//   // A dependency stops blocking once it reaches a terminal status. A referenced
//   // ticket that no longer exists is treated as resolved — blocking forever on a
//   // deleted dependency would deadlock the dependent ticket.
//   export function getOpenBlockers(ticket) {
//     const deps = Array.isArray(ticket?.blockedBy) ? ticket.blockedBy : [];
//     const open = [];
//     for (const depId of deps) {
//       const dep = ticketStore.getTicket(depId);
//       if (!dep) continue;                              // ← missing dep is DROPPED
//       if (!isDependencyClosed(dep.status)) open.push(depId);
//     }
//     return open;
//   }
//
// The sibling suite service-get-open-blockers-nullish-ticket.test.ts pins the
// null/non-array input guard, and service-claim-mixed-blockers.test.ts pins the
// done/cancelled exclusion — but ALWAYS with dependencies that exist in the
// store. The `if (!dep) continue` branch — a blockedBy pointing at a ticket that
// was deleted (getTicket returns null) — is not directly pinned anywhere. That
// branch is the deadlock-avoidance contract: a deleted dependency can never
// reach a terminal status, so if it kept counting as "open" the dependent ticket
// would be unclaimable forever. This file pins "missing dependency is treated as
// resolved (dropped), never blocking".
//
// All I/O is mocked — no real FS, no real bus, deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  config: { ZANA_DIR: "/tmp/zana-open-blockers-missing-dep" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedDep(id: string, status: string) {
  fakeDb._tickets.set(id, { id, status, blockedBy: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("getOpenBlockers — deleted/missing dependency is treated as resolved", () => {
  it("drops a blockedBy id that does not exist in the store", () => {
    // No ticket seeded for GHOST-DEP → getTicket returns null → dropped.
    const blockers = svc.getOpenBlockers({ blockedBy: ["GHOST-DEP"] });
    expect(blockers).toEqual([]);
  });

  it("counts the open dep but drops the missing one when both are present", () => {
    seedDep("OPEN-DEP", "in-progress"); // genuinely blocking
    // MISSING-DEP is never seeded — must be dropped, not reported.
    const blockers = svc.getOpenBlockers({ blockedBy: ["MISSING-DEP", "OPEN-DEP"] });
    expect(blockers).toEqual(["OPEN-DEP"]);
  });

  it("returns [] when every dependency is missing (no deadlock)", () => {
    // A ticket whose only blockers were deleted must become claimable — if the
    // missing deps still counted as open, this would be a permanent deadlock.
    const blockers = svc.getOpenBlockers({ blockedBy: ["DEL-1", "DEL-2", "DEL-3"] });
    expect(blockers).toEqual([]);
  });

  it("does not confuse a missing dep with a terminal one — open deps still block", () => {
    seedDep("DONE-DEP", "done"); // terminal → not blocking
    seedDep("REVIEW-DEP", "review"); // open → blocking
    // GONE-DEP missing → dropped. Only REVIEW-DEP should remain.
    const blockers = svc.getOpenBlockers({
      blockedBy: ["DONE-DEP", "GONE-DEP", "REVIEW-DEP"],
    });
    expect(blockers).toEqual(["REVIEW-DEP"]);
  });
});
