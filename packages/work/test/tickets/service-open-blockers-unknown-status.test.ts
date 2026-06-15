// Focused test for the unknown/garbage dependency-status branch of
// service.getOpenBlockers.
//
// service.ts:
//   function isDependencyClosed(status) {
//     return status === "done" || status === "cancelled";
//   }
//   export function getOpenBlockers(ticket) {
//     ...
//     if (!dep) continue;                              // ← missing dep dropped
//     if (!isDependencyClosed(dep.status)) open.push(depId);  // ← else still blocks
//   }
//
// Two sibling suites pin the neighbouring branches:
//   - service-open-blockers-missing-dependency.test.ts: a dep that DOESN'T
//     exist (getTicket → null) is dropped, never blocking (deadlock avoidance).
//   - service-claim-mixed-blockers.test.ts: deps with the KNOWN statuses
//     done/cancelled are closed; in-progress/review/backlog still block.
//
// Neither covers a dep that EXISTS but carries a status that is NOT one of the
// two terminal values — e.g. a persisted record whose `status` field is
// missing, empty, or a garbage string. `isDependencyClosed` is an allow-list
// (only "done"/"cancelled" close a dep), so any such value is conservatively
// treated as STILL OPEN. This is the deadlock-avoidance counterpart to the
// missing-dep rule: a present-but-unrecognised dependency must keep blocking,
// never be silently assumed resolved. This file pins that contract.
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
  config: { ZANA_DIR: "/tmp/zana-open-blockers-unknown-status" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedDep(id: string, status: any) {
  fakeDb._tickets.set(id, { id, status, blockedBy: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("getOpenBlockers — existing dependency with unknown/garbage status still blocks", () => {
  it("treats a dependency whose status field is missing as still open", () => {
    fakeDb._tickets.set("NO-STATUS-DEP", { id: "NO-STATUS-DEP", blockedBy: [] }); // no status key
    expect(svc.getOpenBlockers({ blockedBy: ["NO-STATUS-DEP"] })).toEqual(["NO-STATUS-DEP"]);
  });

  it("treats undefined / empty-string / unrecognised statuses as still open", () => {
    seedDep("UNDEF-DEP", undefined);
    seedDep("EMPTY-DEP", "");
    seedDep("GARBAGE-DEP", "completed"); // close-sounding but NOT in the allow-list
    expect(svc.getOpenBlockers({ blockedBy: ["UNDEF-DEP", "EMPTY-DEP", "GARBAGE-DEP"] }))
      .toEqual(["UNDEF-DEP", "EMPTY-DEP", "GARBAGE-DEP"]);
  });

  it("only the genuine terminal statuses (done/cancelled) close a present dep", () => {
    seedDep("DONE-DEP", "done"); // closed
    seedDep("CANCELLED-DEP", "cancelled"); // closed
    seedDep("WEIRD-DEP", "archived"); // unknown → still blocks
    // blockedBy order is preserved for the still-open subset.
    expect(svc.getOpenBlockers({
      blockedBy: ["DONE-DEP", "WEIRD-DEP", "CANCELLED-DEP"],
    })).toEqual(["WEIRD-DEP"]);
  });
});
