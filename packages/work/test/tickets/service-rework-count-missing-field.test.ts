// Focused test for the reworkCount fallback operand in updateStatus().
//
// src/tickets/service.ts (rework transition):
//   if (newStatus === "rework") {
//     ticket.reviewPhase = null;
//     ticket.reworkCount = (ticket.reworkCount || 0) + 1;
//   }
//
// Every existing test seeds reworkCount to 0 or a positive integer, so the
// `|| 0` operand — the legacy/migrated-ticket path where the field is entirely
// absent (undefined) — has never been exercised. A ticket that predates the
// reworkCount column (or a record reconstructed without it) must increment to
// a real number (1), NOT to NaN (`undefined + 1`). This pins that fallback so a
// refactor that drops the `|| 0` guard is caught.
//
// All I/O and event-bus interactions are mocked — no real FS, no real clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeBus, fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) =>
      tickets.has(id) ? structuredClone(tickets.get(id)) : null,
    ),
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
  config: { ZANA_DIR: "/tmp/zana-rework-count-test" },
  project: {
    workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" },
  },
  util: {
    logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
  },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// Seeds a "review" ticket that deliberately OMITS the reworkCount field, the
// way a record migrated from a schema predating the column would look.
function seedLegacyReviewTicket() {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const ticket: Record<string, any> = {
    id,
    title: "Legacy ticket without reworkCount",
    description: "",
    status: "review",
    priority: "medium",
    assigneeId: null,
    assigneeName: null,
    assigneeProfileId: null,
    reviewPhase: "qa",
    // reworkCount intentionally absent
    sprintId: null,
    labels: [],
    blockedBy: [],
    comments: [],
    audit: [],
    createdBy: "test",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    resultSummary: null,
  };
  fakeDb._tickets.set(id, ticket);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("updateStatus — review → rework with no pre-existing reworkCount", () => {
  it("initializes reworkCount to 1 (not NaN) via the `|| 0` fallback", () => {
    const id = seedLegacyReviewTicket();

    const result = svc.updateStatus(id, "rework", "qa-bot") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.reworkCount).toBe(1);
    // Guard the specific regression: a dropped `|| 0` yields `undefined + 1` = NaN.
    expect(Number.isNaN(result.ticket.reworkCount)).toBe(false);
  });

  it("also clears reviewPhase on the same rework transition", () => {
    const id = seedLegacyReviewTicket();

    const result = svc.updateStatus(id, "rework", "qa-bot") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.reviewPhase).toBeNull();
  });

  it("persists the initialized reworkCount to the store", () => {
    const id = seedLegacyReviewTicket();

    svc.updateStatus(id, "rework", "qa-bot");

    const saved = fakeDb._tickets.get(id);
    expect(saved.reworkCount).toBe(1);
  });
});
