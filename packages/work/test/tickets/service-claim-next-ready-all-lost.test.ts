// Covers the post-loop fallthrough in claimNextReady (service.ts): when the
// ready snapshot is non-empty but EVERY candidate is claimed out from under us
// by a racing dispatcher before we can claim it, the loop exhausts all
// candidates and returns { ok: false, reason: "none_ready" }.
//
// The existing dependency-ordering suite only exercises the early
// `ready.length === 0` return; this drives the distinct exit after the loop.
// All I/O mocked — deterministic, no real db/bus.

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
  config: { ZANA_DIR: "/tmp/zana-claim-lost-test" },
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

describe("claimNextReady — all candidates lost to a race", () => {
  it("returns none_ready when every ready ticket becomes unclaimable after the snapshot", () => {
    seedTicket({ id: "head", priority: "critical" });
    seedTicket({ id: "next", priority: "high" });

    // After listReadyTickets takes its snapshot (both still backlog), a racing
    // dispatcher claims BOTH tickets. Each claimTicket in the loop then reads
    // in-progress and fails, exhausting the candidate list.
    const realList = fakeDb.listTickets.getMockImplementation()!;
    let snapshotTaken = false;
    fakeDb.listTickets.mockImplementation((filter?: any) => {
      const rows = realList(filter);
      if (!snapshotTaken) {
        snapshotTaken = true;
        fakeDb._tickets.get("head").status = "in-progress";
        fakeDb._tickets.get("next").status = "in-progress";
      }
      return rows;
    });

    const res = svc.claimNextReady("agent-1", "Agent One");

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("none_ready");
    // No claim succeeded → no ticket:claimed emitted.
    expect(fakeBus.emit).not.toHaveBeenCalledWith("ticket:claimed", expect.anything());
  });
});
