// Focused tests for claimTicket's audit trail and reviewPhase reset in
// packages/work/src/tickets/service.ts.
//
// The sibling claim tests assert status/assignee/profileId, but none pin two
// observable invariants of a successful claim:
//   1. claimTicket appends TWO audit entries — a "claimed" entry (carrying the
//      resolved agentName + profileId) followed by a "status_changed" entry
//      (from the old status → "in-progress"). A refactor that drops either
//      entry would break the audit log silently.
//   2. claimTicket clears any lingering reviewPhase (src line 169), regardless
//      of what was stored. A rework ticket that somehow still carries
//      reviewPhase="qa" must come back clean once re-claimed.
//
// All db/bus I/O is mocked — no real FS, no real clock, no real bus.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()]),
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
  config: { ZANA_DIR: "/tmp/zana-claim-audit" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
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

describe("claimTicket — audit trail", () => {
  it("appends a 'claimed' entry then a 'status_changed' entry, in that order", () => {
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-1", "Agent One", "coder-profile") as any;

    expect(result.ok).toBe(true);
    const actions = result.ticket.audit.map((a: any) => a.action);
    // Both entries exist...
    expect(actions).toContain("claimed");
    expect(actions).toContain("status_changed");
    // ...and the claim is recorded before the status flip.
    expect(actions.indexOf("claimed")).toBeLessThan(actions.indexOf("status_changed"));
  });

  it("records agentName + profileId on the 'claimed' entry and the transition on 'status_changed'", () => {
    const id = seed({ status: "rework" });
    const result = svc.claimTicket(id, "agent-2", "Agent Two", "arch-profile") as any;

    const claimed = result.ticket.audit.find((a: any) => a.action === "claimed");
    expect(claimed.actor).toBe("agent-2");
    expect(claimed.details).toEqual({ agentName: "Agent Two", profileId: "arch-profile" });

    const changed = result.ticket.audit.find((a: any) => a.action === "status_changed");
    expect(changed.details).toEqual({ from: "rework", to: "in-progress" });
  });

  it("clears a lingering reviewPhase when the ticket is claimed", () => {
    // Stored-inconsistency guard: a rework ticket still carrying reviewPhase
    // must come back null once re-claimed (src line 169).
    const id = seed({ status: "rework", reviewPhase: "qa" });
    const result = svc.claimTicket(id, "agent-3", "Agent Three") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBeNull();
    // And the reset is persisted, not just returned.
    expect(svc.getTicket(id).reviewPhase).toBeNull();
  });
});
