// Tests service.recordVerdict: the structured review-verdict path. It validates
// the verdict kind, emits "ticket:verdict" for the watcher to consume, and does
// NOT itself mutate the ticket (the watcher owns the state transition).
//
// recordVerdict resolves the bus via require("@zana-ai/core") at call time, so
// we exercise the REAL core bus (subscribing to "ticket:verdict") and mock only
// the ticket store — mirroring watcher-structured-verdict.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => (tickets.has(id) ? structuredClone(tickets.get(id)) : null)),
    listTickets: vi.fn(() => [...tickets.values()]), deleteTicket: vi.fn(),
    saveSprint: vi.fn(), getSprint: vi.fn(), listSprints: vi.fn(() => []), deleteSprint: vi.fn(),
    _tickets: tickets,
  };
  return { fakeDb };
});

vi.mock("@zana-ai/work/src/tickets/db.ts", () => fakeDb);

import * as svc from "@zana-ai/work/src/tickets/service.ts";
import * as core from "@zana-ai/core";

const bus = (core as any).events.bus;
let emitted: any[] = [];
const handler = (p: any) => emitted.push(p);

function seed(overrides: Record<string, any> = {}) {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const ticket = {
    id, title: "x", description: "", status: "review", priority: "high",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: "qa", reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
    ...overrides,
  };
  fakeDb._tickets.set(id, ticket);
  return ticket;
}

beforeEach(() => {
  fakeDb._tickets.clear();
  fakeDb.saveTicket.mockClear();
  emitted = [];
  bus.on("ticket:verdict", handler);
});
afterEach(() => { bus.off("ticket:verdict", handler); });

describe("service.recordVerdict", () => {
  it("emits ticket:verdict for a valid kind without mutating the ticket", () => {
    const t = seed();
    const before = structuredClone(fakeDb._tickets.get(t.id));
    const res: any = svc.recordVerdict(t.id, "PASS", "looks good", "code-reviewer");

    expect(res).toMatchObject({ ok: true, ticketId: t.id, verdict: "PASS", reason: "looks good" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      ticketId: t.id, kind: "PASS", reason: "looks good",
      profileLabel: "code-reviewer", reportedBy: "code-reviewer",
    });
    // The service must not own the transition — ticket is untouched.
    expect(fakeDb._tickets.get(t.id)).toEqual(before);
    expect(fakeDb.saveTicket).not.toHaveBeenCalled();
  });

  it("normalizes a lower-case kind to upper-case", () => {
    const t = seed();
    const res: any = svc.recordVerdict(t.id, "fail", "null deref", "qa");
    expect(res.verdict).toBe("FAIL");
    expect(emitted.at(-1).kind).toBe("FAIL");
  });

  it("rejects an unknown verdict kind and emits nothing", () => {
    const t = seed();
    const res: any = svc.recordVerdict(t.id, "MAYBE", null, "qa");
    expect(res.error).toContain("invalid verdict");
    expect(emitted).toHaveLength(0);
  });

  it("defaults reason to null and profileLabel to reportedBy then 'reviewer'", () => {
    const t = seed();
    svc.recordVerdict(t.id, "READY", undefined, "agent-7");
    expect(emitted.at(-1)).toMatchObject({ reason: null, profileLabel: "agent-7", reportedBy: "agent-7" });

    svc.recordVerdict(t.id, "BLOCKED");
    expect(emitted.at(-1)).toMatchObject({ profileLabel: "reviewer", reportedBy: "agent" });
  });

  it("errors for a missing ticket and emits nothing", () => {
    expect(svc.recordVerdict("nope", "PASS", null, "qa").error).toBeTruthy();
    expect(emitted).toHaveLength(0);
  });
});
