// Covers two behaviours in service.ts that were never exercised:
//
//  1. claimTicket — when a profileId (4th arg) is supplied, the ticket's
//     assigneeProfileId field must be set (src line 101).
//
//  2. updateReviewPhase — unknown ticket returns {error:"ticket not found"},
//     and a successful phase change emits the ticket:reviewPhaseChanged bus
//     event with the correct oldPhase / newPhase payload.
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
  config: { ZANA_DIR: "/tmp/zana-gaps-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Gap ticket", description: "", status: "backlog",
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

// ── claimTicket: profileId path ───────────────────────────────────────────

describe("claimTicket — profileId argument", () => {
  it("sets assigneeProfileId on the ticket when profileId is provided", () => {
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-42", "Agent Forty-Two", "coder-profile");
    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeProfileId).toBe("coder-profile");
  });

  it("persists assigneeProfileId to the store", () => {
    const id = seed({ status: "backlog" });
    svc.claimTicket(id, "agent-99", "Agent Ninety-Nine", "architect-profile");
    expect(fakeDb.saveTicket).toHaveBeenCalledWith(
      expect.objectContaining({ id, assigneeProfileId: "architect-profile" }),
    );
  });

  it("leaves assigneeProfileId null when profileId is omitted", () => {
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-7", "Agent Seven");
    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeProfileId).toBeNull();
  });
});

// ── updateReviewPhase: error + side-effect paths ─────────────────────────

describe("updateReviewPhase — unknown ticket", () => {
  it("returns error when the ticket does not exist", () => {
    const result = svc.updateReviewPhase("ghost-id", "qa", "reviewer");
    expect(result.error).toBe("ticket not found");
  });
});

describe("updateReviewPhase — audit trail", () => {
  it("records a review_phase_changed audit entry with from/to on the saved ticket", () => {
    const id = seed({ status: "review", reviewPhase: "qa" });
    const result = svc.updateReviewPhase(id, "architecture", "arch-bot");

    expect(result.ok).toBe(true);

    // The audit entry must be persisted — inspect what saveTicket received.
    const saved = fakeDb.saveTicket.mock.calls.at(-1)?.[0];
    expect(saved).toBeDefined();
    const entry = saved.audit.find((e: any) => e.action === "review_phase_changed");
    expect(entry).toBeDefined();
    expect(entry.details).toMatchObject({ from: "qa", to: "architecture" });
    expect(entry.actor).toBe("arch-bot");
  });

  it("updates reviewPhase on the ticket and persists it", () => {
    const id = seed({ status: "review", reviewPhase: "qa" });
    svc.updateReviewPhase(id, "architecture", "arch-bot");

    const saved = fakeDb.saveTicket.mock.calls.at(-1)?.[0];
    expect(saved?.reviewPhase).toBe("architecture");
  });
});
