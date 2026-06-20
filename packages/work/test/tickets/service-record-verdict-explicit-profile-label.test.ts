// Focused test for the 5th parameter of service.recordVerdict — `profileLabel`.
//
// recordVerdict(ticketId, kind, reason, reportedBy, profileLabel?) emits
// "ticket:verdict" with `profileLabel: profileLabel || reportedBy || "reviewer"`.
//
// service-record-verdict.test.ts pins the FALLBACK chain (profileLabel omitted
// → reportedBy → "reviewer"), but never passes the 5th argument. This file
// closes that gap: when a caller supplies an explicit profileLabel it must win
// over reportedBy in the emitted event, while `reportedBy` is reported
// independently. Without this, a refactor that drops/ignores the 5th param
// (e.g. always using reportedBy as the label) would pass the existing suite.
//
// Mirrors service-record-verdict.test.ts: exercises the REAL core bus and
// mocks only the ticket store. Deterministic — no FS, no network, no clock.

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

function seed() {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const ticket = {
    id, title: "x", description: "", status: "review", priority: "high",
    assigneeId: null, assigneeName: null, assigneeProfileId: null,
    reviewPhase: "qa", reworkCount: 0, sprintId: null, labels: [],
    blockedBy: [], comments: [], audit: [], createdBy: "test",
    createdAt: now, updatedAt: now, closedAt: null, resultSummary: null,
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

describe("service.recordVerdict — explicit profileLabel argument", () => {
  it("uses an explicit profileLabel over reportedBy in the emitted event", () => {
    const t = seed();
    const res: any = svc.recordVerdict(t.id, "PASS", "ok", "agent-9", "qa-reviewer");

    expect(res).toMatchObject({ ok: true, verdict: "PASS" });
    expect(emitted).toHaveLength(1);
    // profileLabel wins; reportedBy is still surfaced independently.
    expect(emitted[0]).toMatchObject({
      ticketId: t.id,
      kind: "PASS",
      profileLabel: "qa-reviewer",
      reportedBy: "agent-9",
    });
  });

  it("treats an empty-string profileLabel as absent and falls back to reportedBy", () => {
    const t = seed();
    svc.recordVerdict(t.id, "FAIL", "regression", "agent-3", "");
    // "" is falsy → falls through to reportedBy, not used as the label.
    expect(emitted.at(-1)).toMatchObject({
      profileLabel: "agent-3",
      reportedBy: "agent-3",
    });
  });
});
