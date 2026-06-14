// Focused test: updateTicket accepts valid `type` values and persists them.
//
// service-update-complete.test.ts already covers the rejection of invalid
// types (e.g. "task" → `invalid type`).  The complementary happy-path —
// confirming that VALID_TYPES ("bug", "feature", "chore", "spike") are each
// accepted, written to the ticket, and persisted via saveTicket — was
// previously untested.
//
// The `type` field lives in UPDATABLE_FIELDS (service.ts line 182) and is
// guarded by a separate validation branch (lines 206-210).  A successful write
// should return `{ ok: true, ticket }` with `ticket.type === <value>` and the
// store should have received the updated ticket.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoist mocks ───────────────────────────────────────────────────────────────
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
  config: { ZANA_DIR: "/tmp/zana-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Seed ticket", description: "", status: "backlog",
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe("updateTicket — valid type field", () => {
  it.each(["bug", "feature", "chore", "spike"] as const)(
    "accepts type=%s and returns the updated ticket",
    (validType) => {
      const id = seed();
      const result = svc.updateTicket(id, { type: validType }, "actor") as any;

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.ticket.type).toBe(validType);
    },
  );

  it("persists the new type to the store via saveTicket", () => {
    const id = seed();
    svc.updateTicket(id, { type: "bug" }, "actor");

    const savedTicket = (fakeDb.saveTicket as ReturnType<typeof vi.fn>)
      .mock.calls.at(-1)![0];
    expect(savedTicket.type).toBe("bug");
  });

  it("can update type alongside other valid fields in one call", () => {
    const id = seed();
    const result = svc.updateTicket(
      id,
      { type: "chore", title: "Housekeeping", priority: "low" },
      "ci",
    ) as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.type).toBe("chore");
    expect(result.ticket.title).toBe("Housekeeping");
    expect(result.ticket.priority).toBe("low");
  });
});
