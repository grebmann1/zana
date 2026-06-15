// listReadyTickets — age tie-break is an ACTIVE sort, not insertion order.
//
// packages/work/src/tickets/service.ts listReadyTickets():
//   ready.sort((a, b) => {
//     ...priority compare...
//     return String(a.createdAt).localeCompare(String(b.createdAt));  // oldest first
//   });
//
// The existing "orders by priority then age" test seeds same-priority tickets
// in age order, so a stable sort would yield the right answer even if the
// createdAt comparator were a no-op. This file pins the comparator itself: the
// OLDER ticket is inserted (and therefore returned by the store) AFTER the
// newer one, so only a real createdAt comparison can surface it first.
//
// All I/O is mocked — no real FS, no real bus, deterministic.

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
    deleteTicket: vi.fn(),
    saveSprint: vi.fn(),
    getSprint: vi.fn(),
    listSprints: vi.fn(() => [...sprints.values()]),
    deleteSprint: vi.fn(),
    _tickets: tickets,
    _sprints: sprints,
  };

  const fakeBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { fakeBus, fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus },
  config: { ZANA_DIR: "/tmp/zana-ready-age-tiebreak" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seedTicket(overrides: Record<string, any>) {
  const id = overrides.id;
  fakeDb._tickets.set(id, {
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
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    closedAt: null,
    resultSummary: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  fakeDb._sprints.clear();
});

describe("listReadyTickets — age tie-break reorders against insertion order", () => {
  it("puts the older same-priority ticket first even when it is stored last", () => {
    // Insert the NEWER ticket first; the store returns it first. A stable sort
    // with a no-op tie-break would leave it first. The real comparator must
    // move the older ticket (inserted last) ahead of it.
    seedTicket({ id: "newer", priority: "medium", createdAt: "2026-03-01T00:00:00.000Z" });
    seedTicket({ id: "older", priority: "medium", createdAt: "2026-01-01T00:00:00.000Z" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["older", "newer"]);
  });

  it("keeps priority ahead of age (a newer critical beats an older medium)", () => {
    seedTicket({ id: "older-medium", priority: "medium", createdAt: "2026-01-01T00:00:00.000Z" });
    seedTicket({ id: "newer-critical", priority: "critical", createdAt: "2026-06-01T00:00:00.000Z" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["newer-critical", "older-medium"]);
  });
});
