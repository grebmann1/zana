// Field-allowlist invariant for updateTicket() in service.ts.
//
// service-update-complete.test.ts pins the two pure cases:
//   - fields with ONLY non-updatable keys  → "no valid updatable fields"
//   - fields with ONLY updatable keys       → applied
//
// It does NOT pin the security-relevant MIXED case: when a caller passes both a
// non-updatable, transition-gated key (e.g. `status`) AND a legitimately
// updatable key (e.g. `title`), updateTicket must apply the updatable field and
// SILENTLY IGNORE the non-updatable one — it copies only keys in UPDATABLE_FIELDS
// (service.ts line 332). This is what stops updateTicket from being a backdoor
// around updateStatus()'s STATUS_TRANSITIONS gate (and around assignee writes).
//
// The audit entry's `details.fields` is also pinned: it records only the
// fields actually changed (`changedFields`, line 344) — the ignored
// non-updatable key never appears there.
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
  config: { ZANA_DIR: "/tmp/zana-update-allowlist-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "Seed", description: "", status: "backlog",
    priority: "medium", assigneeId: null, assigneeName: null,
    assigneeProfileId: null, reviewPhase: null, reworkCount: 0,
    sprintId: null, labels: [], blockedBy: [], comments: [], audit: [],
    createdBy: "test", createdAt: now, updatedAt: now,
    closedAt: null, resultSummary: null, ...overrides,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

describe("updateTicket — field allowlist (non-updatable keys are ignored, not applied)", () => {
  it("applies the updatable key and silently ignores a non-updatable `status` key", () => {
    const id = seed({ status: "backlog" });

    const result = svc.updateTicket(id, { title: "Renamed", status: "done" } as any, "alice") as any;

    expect(result.ok).toBe(true);
    // The updatable field landed...
    expect(result.ticket.title).toBe("Renamed");
    // ...but the transition-gated `status` was NOT touched by updateTicket.
    expect(result.ticket.status).toBe("backlog");

    const saved = fakeDb._tickets.get(id);
    expect(saved.title).toBe("Renamed");
    expect(saved.status).toBe("backlog");
  });

  it("does not let updateTicket overwrite assignee fields even when a valid field is present", () => {
    const id = seed({ assigneeId: null, assigneeName: null });

    const result = svc.updateTicket(
      id,
      { labels: ["urgent"], assigneeId: "agent-evil", assigneeName: "Mallory", reworkCount: 99 } as any,
      "alice",
    ) as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.labels).toEqual(["urgent"]);
    // None of the non-updatable identity/lifecycle fields were written.
    expect(result.ticket.assigneeId).toBeNull();
    expect(result.ticket.assigneeName).toBeNull();
    expect(result.ticket.reworkCount).toBe(0);
  });

  it("audit details.fields records only the changed updatable field, not the ignored key", () => {
    const id = seed({ status: "backlog" });

    svc.updateTicket(id, { title: "Renamed", status: "done" } as any, "alice");

    const saved = fakeDb._tickets.get(id);
    const updatedEntry = saved.audit.find((a: any) => a.action === "updated");
    expect(updatedEntry).toBeTruthy();
    // Audit reflects what actually changed — `status` is absent because it was
    // never copied (it is not in UPDATABLE_FIELDS).
    expect(updatedEntry.details.fields).toEqual(["title"]);
  });
});
