// Covers profileId forwarding in claimNextReady (service.ts):
//   export function claimNextReady(agentId, agentName, profileId?, filter)
//     -> claimTicket(candidate.id, agentId, agentName, profileId)
//   and claimTicket: `if (profileId) ticket.assigneeProfileId = profileId`.
//
// The sibling claim-next-ready suites (all-lost / skip-lost / sprint-filter)
// never pass a profileId, so none pin the forwarding. A regression that dropped
// the 3rd positional arg in the claimTicket call inside claimNextReady would
// silently leave assigneeProfileId null for every dispatched ticket — and pass
// every existing test. This file pins that the profile id reaches the claimed
// ticket (returned + persisted) and its "claimed" audit entry.
// All I/O mocked — deterministic, no real db/bus/clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  config: { ZANA_DIR: "/tmp/zana-claim-profile-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any> = {}) {
  const id = overrides.id;
  const createdAt = overrides.createdAt || "2026-01-01T00:00:00.000Z";
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
    createdAt,
    updatedAt: createdAt,
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

describe("claimNextReady — profileId forwarding", () => {
  it("forwards profileId to the claimed ticket, its audit entry, and the claimed event", () => {
    seedTicket({ id: "ready", priority: "critical" });

    const res = svc.claimNextReady("agent-1", "Agent One", "profile-architect") as any;

    expect(res.ok).toBe(true);
    expect(res.ticket.id).toBe("ready");
    // The 3rd positional arg must reach claimTicket and land on the ticket.
    expect(res.ticket.assigneeProfileId).toBe("profile-architect");

    // Persisted state carries the profile id, not just the returned object.
    expect(fakeDb._tickets.get("ready").assigneeProfileId).toBe("profile-architect");

    // The audit "claimed" entry records the profile id.
    const claimedEntry = res.ticket.audit.find((a: any) => a.action === "claimed");
    expect(claimedEntry?.details?.profileId).toBe("profile-architect");
  });

  it("leaves assigneeProfileId null when no profileId is supplied", () => {
    seedTicket({ id: "ready", priority: "high" });

    const res = svc.claimNextReady("agent-1", "Agent One") as any;

    expect(res.ok).toBe(true);
    expect(res.ticket.assigneeProfileId).toBe(null);
  });
});
