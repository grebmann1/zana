// Focused tests for addComment() in service.ts — the audit-body truncation
// invariant and the unknown-ticket guard, neither of which the existing
// add-comment suite (authorName fallback) exercises.
//
// service.ts line 284:
//   addAuditEntry(ticket, "commented", authorId, { body: body.slice(0, 100) });
//
// The audit trail stores only the first 100 chars of the comment body so a
// pathologically long comment can't bloat every audit row, while the full
// body is still preserved on the comment record itself. This file pins that
// split so a refactor can't accidentally drop the truncation (log bloat) or
// truncate the stored comment (data loss).
//
// All I/O and bus interactions are mocked — no real FS, no real bus.

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
  config: { ZANA_DIR: "/tmp/zana-add-comment-audit-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed() {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "in-progress",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("addComment — audit-body truncation", () => {
  it("returns 'ticket not found' for an unknown ticketId and saves nothing", () => {
    const result = svc.addComment("ghost", "agent-1", "Alice", "hi") as any;
    expect(result.error).toBe("ticket not found");
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });

  it("truncates the audit body to 100 chars while storing the full comment body", () => {
    const id = seed();
    const longBody = "x".repeat(250);

    const result = svc.addComment(id, "agent-1", "Alice", longBody) as any;
    expect(result.ok).toBe(true);
    // Full body is preserved on the comment record.
    expect(result.comment.body).toBe(longBody);

    // Audit entry stores only the first 100 chars.
    const saved = fakeDb._tickets.get(id);
    const commentedEntry = saved.audit.find((a: any) => a.action === "commented");
    expect(commentedEntry).toBeTruthy();
    expect(commentedEntry.details.body).toHaveLength(100);
    expect(commentedEntry.details.body).toBe("x".repeat(100));
  });

  it("leaves a short body intact in the audit entry (no padding/truncation)", () => {
    const id = seed();
    svc.addComment(id, "agent-1", "Alice", "LGTM");
    const saved = fakeDb._tickets.get(id);
    const commentedEntry = saved.audit.find((a: any) => a.action === "commented");
    expect(commentedEntry.details.body).toBe("LGTM");
  });
});
