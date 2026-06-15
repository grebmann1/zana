// listReadyTickets — priority sort spans the backlog/rework concatenation.
//
// packages/work/src/tickets/service.ts listReadyTickets():
//   const candidates = [
//     ...ticketStore.listTickets({ status: "backlog" }),
//     ...ticketStore.listTickets({ status: "rework" }),
//   ];
//   ...
//   ready.sort((a, b) => { ...priority then createdAt... });
//
// Candidates are built by concatenating ALL backlog tickets first, then ALL
// rework tickets, BEFORE the single priority/age sort runs. The existing
// coverage does not pin the cross-status ordering:
//   - service-ready-age-tiebreak.test.ts seeds only backlog tickets.
//   - service-ready-excludes-active-and-terminal.test.ts proves both statuses
//     are *included*, but asserts with `.sort()` on the result ids, which
//     discards the dispatch order entirely.
//
// So nothing today fails if a regression special-cased backlog ahead of rework
// (e.g. returned the concatenation unsorted, or sorted each source list
// independently). This file pins the real contract: the final order is a single
// priority-then-age ranking across BOTH source statuses, so a high-priority
// rework ticket is dispatched ahead of a lower-priority backlog ticket, and a
// same-priority older ticket wins regardless of which status it came from.
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
  config: { ZANA_DIR: "/tmp/zana-ready-cross-status-priority" },
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
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
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

describe("listReadyTickets — priority sort spans backlog and rework", () => {
  it("dispatches a critical rework ticket ahead of a medium backlog ticket", () => {
    // backlog is concatenated before rework, so only a real cross-status sort
    // can move the rework ticket to the head.
    seedTicket({ id: "backlog-medium", status: "backlog", priority: "medium" });
    seedTicket({ id: "rework-critical", status: "rework", priority: "critical" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["rework-critical", "backlog-medium"]);
  });

  it("dispatches a critical backlog ticket ahead of a low rework ticket", () => {
    // The mirror case: backlog wins here on priority, not on concatenation order.
    seedTicket({ id: "backlog-critical", status: "backlog", priority: "critical" });
    seedTicket({ id: "rework-low", status: "rework", priority: "low" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["backlog-critical", "rework-low"]);
  });

  it("breaks a same-priority tie by age across statuses (older rework beats newer backlog)", () => {
    // Equal priority: the older ticket wins even though it is a rework ticket
    // appended after the newer backlog ticket in the candidate list.
    seedTicket({ id: "backlog-newer", status: "backlog", priority: "high", createdAt: "2026-06-01T00:00:00.000Z" });
    seedTicket({ id: "rework-older", status: "rework", priority: "high", createdAt: "2026-01-01T00:00:00.000Z" });

    const ready = svc.listReadyTickets();
    expect(ready.map((t: any) => t.id)).toEqual(["rework-older", "backlog-newer"]);
  });
});
