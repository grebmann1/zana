// Tests for the human-checkpoint EVENT contract (#2, ADR 0011).
//
// requestHumanCheckpoint/resolveHumanCheckpoint exist so a surface layer (inbox,
// Slack, UI badge) can PROACTIVELY alert that "a human must look". That proactive
// alert IS the event emission — `ticket:needsHuman` on park and
// `ticket:humanResolved` on resolve. The sibling test file asserts the audit
// trail and status side effects but never the emitted events, so a regression
// that silently dropped the emit would pass every existing test. These tests
// pin the event payloads.
//
// The db is faked (no real FS). `@zana-ai/core` is deliberately NOT mocked: the
// service resolves its bus lazily via `require("@zana-ai/core").events.bus`, so
// we attach a listener to that same real singleton bus to capture the emit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn(() => [...tickets.values()].map((t) => structuredClone(t))),
    deleteTicket: vi.fn((id: string) => { tickets.delete(id); }),
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
// Real singleton bus — the same instance the service emits on.
const bus: any = (require("@zana-ai/core") as any).events.bus;

function seed(id: string, status = "in-progress") {
  fakeDb._tickets.set(id, {
    id, title: `ticket ${id}`, status,
    labels: [], blockedBy: [], comments: [], parentId: null, audit: [],
  });
}

let needsHuman: any[];
let humanResolved: any[];
const onNeeds = (p: any) => needsHuman.push(p);
const onResolved = (p: any) => humanResolved.push(p);

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
  needsHuman = [];
  humanResolved = [];
  bus.on("ticket:needsHuman", onNeeds);
  bus.on("ticket:humanResolved", onResolved);
});

afterEach(() => {
  bus.off("ticket:needsHuman", onNeeds);
  bus.off("ticket:humanResolved", onResolved);
});

describe("human checkpoint events", () => {
  it("requestHumanCheckpoint emits ticket:needsHuman with the full alert payload", () => {
    seed("H1", "review");
    const res = svc.requestHumanCheckpoint("H1", "need a decision", "agent-7", "approval") as any;

    expect(res).toMatchObject({ ok: true, parked: true });
    expect(needsHuman).toHaveLength(1);
    expect(needsHuman[0]).toEqual({
      ticketId: "H1",
      kind: "approval",
      reason: "need a decision",
      title: "ticket H1",
      status: "review",
      requestedBy: "agent-7",
    });
  });

  it("defaults kind to 'decision' and reason to null in the emitted payload", () => {
    seed("H2");
    svc.requestHumanCheckpoint("H2", undefined as any, undefined as any);
    expect(needsHuman[0]).toMatchObject({ kind: "decision", reason: null, requestedBy: "system" });
  });

  it("does NOT re-emit when re-parking an already-parked ticket (idempotent)", () => {
    seed("H3");
    svc.requestHumanCheckpoint("H3", "x", "agent");
    svc.requestHumanCheckpoint("H3", "x", "agent");
    expect(needsHuman).toHaveLength(1);
  });

  it("resolveHumanCheckpoint emits ticket:humanResolved reporting it was parked", () => {
    seed("H4");
    svc.requestHumanCheckpoint("H4", "x", "agent");
    const res = svc.resolveHumanCheckpoint("H4", "release", "alice", "looks good") as any;

    expect(res).toMatchObject({ ok: true, resolution: "release", wasParked: true });
    expect(humanResolved).toHaveLength(1);
    expect(humanResolved[0]).toEqual({
      ticketId: "H4",
      resolution: "release",
      resolvedBy: "alice",
      wasParked: true,
    });
  });

  it("resolving an unparked ticket still emits, with wasParked=false and defaults", () => {
    seed("H5");
    svc.resolveHumanCheckpoint("H5", undefined as any, undefined as any);
    expect(humanResolved).toHaveLength(1);
    expect(humanResolved[0]).toMatchObject({ resolution: "released", resolvedBy: "human", wasParked: false });
  });

  it("emits neither event when the ticket does not exist", () => {
    expect((svc.requestHumanCheckpoint("missing", "x", "a") as any).error).toMatch(/not found/);
    expect((svc.resolveHumanCheckpoint("missing", "release", "h") as any).error).toMatch(/not found/);
    expect(needsHuman).toHaveLength(0);
    expect(humanResolved).toHaveLength(0);
  });
});
