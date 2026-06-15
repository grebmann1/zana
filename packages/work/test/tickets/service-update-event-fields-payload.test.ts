// ticket:updated event-payload invariant for updateTicket() in service.ts.
//
// updateTicket AUDITS and EMITS different field lists (service.ts 344 + 346):
//   addAuditEntry(... { fields: changedFields });                 // allowlisted only
//   _bus().emit("ticket:updated", { ... fields: Object.keys(fields) ... }); // ALL keys
//
// The audit records only fields actually applied; the bus event carries every
// key the caller passed, including non-updatable keys silently ignored (e.g. a
// transition-gated `status`). service-update-field-allowlist.test.ts pins the
// audit side; nothing pins the emitted payload, which the ticket-watcher keys
// off. This file pins that divergence.
//
// Determinism: the service resolves its bus lazily via require("@zana-ai/core")
// — a vi.mock factory does NOT intercept it. Following
// service-review-phase-event.test.ts, we subscribe to the REAL core bus
// singleton and capture emits synchronously. Only the db layer is faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@zana-ai/core";

const { fakeDb } = vi.hoisted(() => {
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
  return { fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

import * as svc from "@zana-ai/work/src/tickets/service.ts";

const bus: any = (core as any).events.bus;

let captured: any[];
let handler: (p: any) => void;

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
  captured = [];
  handler = (p: any) => captured.push(p);
  bus.on("ticket:updated", handler);
});

afterEach(() => {
  bus.off("ticket:updated", handler);
});

describe("updateTicket — ticket:updated event carries ALL provided keys (not just changed ones)", () => {
  it("emits fields = Object.keys(fields), including an ignored non-updatable key", () => {
    const id = seed({ status: "backlog" });

    const res = svc.updateTicket(id, { title: "Renamed", status: "done" } as any, "alice") as any;

    expect(res.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].ticketId).toBe(id);
    expect(captured[0].updatedBy).toBe("alice");
    // The event reports BOTH keys the caller passed — even though `status` was
    // silently ignored (not in UPDATABLE_FIELDS) and never applied.
    expect(captured[0].fields).toEqual(["title", "status"]);
  });

  it("diverges from the audit, which records only the applied field", () => {
    const id = seed({ status: "backlog" });

    svc.updateTicket(id, { title: "Renamed", status: "done" } as any, "alice");

    const saved = fakeDb._tickets.get(id);
    const auditEntry = saved.audit.find((a: any) => a.action === "updated");

    // Same call, two different field lists: the bus event is the broad
    // "what was requested" view; the audit is the narrow "what changed" view.
    expect(captured[0].fields).toEqual(["title", "status"]);
    expect(auditEntry.details.fields).toEqual(["title"]);
  });

  it("emits exactly the updatable key when only an updatable field is provided", () => {
    const id = seed();

    svc.updateTicket(id, { title: "Just a title" }, "bob");

    expect(captured).toHaveLength(1);
    expect(captured[0].fields).toEqual(["title"]);
  });

  it("does not emit on a guard rejection (no valid updatable fields)", () => {
    const id = seed();

    const res = svc.updateTicket(id, { status: "done" } as any, "bob") as any;

    expect(res.error).toMatch(/no valid updatable fields/);
    expect(captured).toHaveLength(0);
  });
});
