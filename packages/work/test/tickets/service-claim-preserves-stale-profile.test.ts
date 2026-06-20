// claimTicket — re-claiming a rework ticket WITHOUT a profileId preserves the
// stale assigneeProfileId rather than clearing it.
//
// service.ts claimTicket only assigns the profile behind a truthy guard:
//
//   if (profileId) ticket.assigneeProfileId = profileId;   // src line 167
//
// Every existing claim test that omits profileId starts from a ticket whose
// assigneeProfileId is already null (a fresh backlog ticket), so they assert
// "stays null" — which would ALSO pass if the guard were removed and the field
// were unconditionally assigned `undefined`. None of them exercise the case
// that actually distinguishes the guard: a ticket that already carries a
// non-null assigneeProfileId (e.g. a rework ticket previously claimed by a
// profiled agent) being re-claimed by an agent that supplies no profileId.
//
// The guard means the OLD profile is preserved, not overwritten/cleared. This
// pins that behaviour so a refactor to `ticket.assigneeProfileId = profileId`
// (dropping the guard) — which would silently wipe the profile to undefined on
// every profileless re-claim — is caught.
//
// All I/O and bus interactions are mocked — no real FS, no real clock.

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
  config: { ZANA_DIR: "/tmp/zana-claim-stale-profile-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Rework ticket", description: "", status: "backlog",
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

describe("claimTicket — stale assigneeProfileId on profileless re-claim", () => {
  it("preserves the existing assigneeProfileId when re-claimed without a profileId", () => {
    // A rework ticket that still carries the profile from its prior claim.
    const id = seed({ status: "rework", assigneeProfileId: "coder-profile" });

    const result = svc.claimTicket(id, "agent-new", "New Agent");

    expect(result.ok).toBe(true);
    // The guard skips the assignment, so the prior profile survives — it is
    // NOT cleared to null/undefined.
    expect(result.ticket.assigneeProfileId).toBe("coder-profile");
  }, 30000); // first svc call in-file pays lazy require("@zana-ai/core") cost; generous timeout survives full-suite parallel contention

  it("persists the preserved profile to the store on a profileless re-claim", () => {
    const id = seed({ status: "rework", assigneeProfileId: "architect-profile" });

    svc.claimTicket(id, "agent-new", "New Agent");

    const saved = fakeDb.saveTicket.mock.calls.at(-1)?.[0];
    expect(saved).toBeDefined();
    expect(saved.assigneeProfileId).toBe("architect-profile");
    // Defensive: the field is genuinely a string, not silently undefined.
    expect(saved.assigneeProfileId).not.toBeUndefined();
  });

  it("overwrites the stale profile when a new profileId IS supplied on re-claim", () => {
    const id = seed({ status: "rework", assigneeProfileId: "coder-profile" });

    const result = svc.claimTicket(id, "agent-new", "New Agent", "reviewer-profile");

    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeProfileId).toBe("reviewer-profile");
  });
});
