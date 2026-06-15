// Focused test for claimTicket's display-name fallback in service.ts.
//
// On a successful claim the service sets:
//     ticket.assigneeName = agentName || agentId   (src line 166)
//
// Every existing claimTicket success test passes an explicit agentName, so the
// `|| agentId` operand has never been exercised. When a caller claims a ticket
// with no human-readable display name (undefined / empty string), the agent's
// id must stand in as the assignee name — both on the persisted ticket and in
// the ticket:claimed event payload that downstream watchers consume.
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
  config: { ZANA_DIR: "/tmp/zana-claim-name-fallback-test" },
  project: { workspaceContext: { isInitialized: () => false, getProjectDir: () => "/tmp" } },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } },
}));

import * as svc from "@zana-ai/work/src/tickets/service.ts";

function seed(overrides: Record<string, any> = {}) {
  const id = `T-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const t = {
    id, title: "Claim ticket", description: "", status: "backlog",
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

describe("claimTicket — assigneeName fallback to agentId", () => {
  it("uses agentId as the assignee name when agentName is undefined", () => {
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-noname") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeId).toBe("agent-noname");
    expect(result.ticket.assigneeName).toBe("agent-noname");
  });

  it("uses agentId as the assignee name when agentName is an empty string", () => {
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-empty", "") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeName).toBe("agent-empty");
  });

  it("persists the fallback assignee name to the store", () => {
    const id = seed({ status: "backlog" });
    svc.claimTicket(id, "agent-persist");

    const saved = fakeDb.saveTicket.mock.calls.at(-1)?.[0];
    expect(saved).toBeDefined();
    expect(saved.assigneeName).toBe("agent-persist");
  });

  it("still honours an explicit agentName over the agentId fallback", () => {
    // Guards the `||` short-circuit: a real display name must win.
    const id = seed({ status: "backlog" });
    const result = svc.claimTicket(id, "agent-named", "Real Name") as any;

    expect(result.ok).toBe(true);
    expect(result.ticket.assigneeName).toBe("Real Name");
  });
});
