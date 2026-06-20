// Tests for #3 (derived stage-history timeline), #2 (human checkpoint), and
// #1 (crash recovery) on the ticket service.
//
// All FS/db I/O is faked — no real FS. The timeline tests pass an explicit
// `nowMs` so durations are deterministic. Checkpoint/recovery side effects are
// asserted via the persisted audit trail rather than the event bus: the service
// resolves its bus lazily via `require("@zana-ai/core").events.bus`, which a
// vi.mock("@zana-ai/core") factory does NOT intercept, so a faked bus would
// never capture the emit.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakeDb } = vi.hoisted(() => {
  const tickets = new Map<string, any>();
  const fakeDb = {
    saveTicket: vi.fn((t: any) => { tickets.set(t.id, structuredClone(t)); }),
    getTicket: vi.fn((id: string) => tickets.has(id) ? structuredClone(tickets.get(id)) : null),
    listTickets: vi.fn((filter?: any) => {
      let all = [...tickets.values()];
      if (filter?.status) all = all.filter((t) => t.status === filter.status);
      if (filter?.parentId !== undefined) {
        all = all.filter((t) => (filter.parentId === null ? !t.parentId : t.parentId === filter.parentId));
      }
      return all.map((t) => structuredClone(t));
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb._tickets.clear();
});

// ── #3 Timeline ──────────────────────────────────────────────────────────────

describe("getTicketTimeline", () => {
  it("returns an error for a missing ticket", () => {
    expect((svc.getTicketTimeline("nope") as any).error).toMatch(/not found/);
  });

  it("reconstructs ordered stages with durations and an open final stage", () => {
    // Build an audit trail by hand with controlled timestamps.
    const t0 = "2026-06-17T00:00:00.000Z";
    const t1 = "2026-06-17T01:00:00.000Z"; // +1h: backlog → in-progress
    const t2 = "2026-06-17T03:00:00.000Z"; // +2h: in-progress → review
    fakeDb._tickets.set("T1", {
      id: "T1", title: "x", status: "review", reviewPhase: "qa",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: [
        { action: "created", actor: "u", timestamp: t0, details: { title: "x" } },
        { action: "status_changed", actor: "u", timestamp: t1, details: { from: "backlog", to: "in-progress" } },
        { action: "status_changed", actor: "u", timestamp: t2, details: { from: "in-progress", to: "review" } },
      ],
      createdAt: t0, updatedAt: t2, closedAt: null,
    });

    const now = Date.parse("2026-06-17T04:00:00.000Z"); // +1h into review
    const tl = svc.getTicketTimeline("T1", now) as any;
    expect(tl.ok).toBe(true);
    expect(tl.stages.map((s: any) => s.status)).toEqual(["backlog", "in-progress", "review"]);
    expect(tl.stages[0].durationMs).toBe(3600000);   // backlog dwelled 1h
    expect(tl.stages[1].durationMs).toBe(7200000);   // in-progress dwelled 2h
    expect(tl.stages[2].open).toBe(true);
    expect(tl.stages[2].durationMs).toBe(3600000);   // review open 1h so far
    expect(tl.totalMs).toBe(4 * 3600000);            // created → now (still open)
  });

  it("counts rework bounces", () => {
    const base = "2026-06-17T00:00:00.000Z";
    fakeDb._tickets.set("T2", {
      id: "T2", title: "x", status: "in-progress",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: [
        { action: "created", actor: "u", timestamp: base, details: {} },
        { action: "status_changed", actor: "u", timestamp: base, details: { from: "review", to: "rework" } },
        { action: "status_changed", actor: "u", timestamp: base, details: { from: "review", to: "rework" } },
      ],
      createdAt: base, updatedAt: base, closedAt: null,
    });
    expect((svc.getTicketTimeline("T2", Date.parse(base)) as any).reworkBounces).toBe(2);
  });

  it("caps totalMs at closedAt for a closed ticket, ignoring wall-clock now", () => {
    // Cycle time of a finished ticket must stop at close, not keep growing with
    // the `now` we pass in. Regression guard for the closedMs branch.
    const t0 = "2026-06-17T00:00:00.000Z";
    const t1 = "2026-06-17T01:00:00.000Z"; // backlog → in-progress
    const t2 = "2026-06-17T02:00:00.000Z"; // in-progress → done (and closed)
    fakeDb._tickets.set("T3", {
      id: "T3", title: "x", status: "done",
      labels: [], blockedBy: [], comments: [], parentId: null,
      audit: [
        { action: "created", actor: "u", timestamp: t0, details: {} },
        { action: "status_changed", actor: "u", timestamp: t1, details: { from: "backlog", to: "in-progress" } },
        { action: "status_changed", actor: "u", timestamp: t2, details: { from: "in-progress", to: "done" } },
        { action: "completed", actor: "u", timestamp: t2, details: {} },
      ],
      createdAt: t0, updatedAt: t2, closedAt: t2,
    });

    // `now` is 8h after close — must NOT bleed into the closed-ticket cycle time.
    const farFutureNow = Date.parse("2026-06-17T10:00:00.000Z");
    const tl = svc.getTicketTimeline("T3", farFutureNow) as any;
    expect(tl.totalMs).toBe(2 * 3600000); // created → closed, capped at closedAt
  });
});

// ── #2 Human checkpoint ───────────────────────────────────────────────────────

function seedSimple(id: string, status = "in-progress") {
  const now = new Date().toISOString();
  fakeDb._tickets.set(id, {
    id, title: "t", status, reviewPhase: null, assigneeId: "a", assigneeName: "a",
    labels: [], blockedBy: [], comments: [], audit: [], parentId: null,
    createdAt: now, updatedAt: now, closedAt: null,
  });
}

describe("requestHumanCheckpoint / resolveHumanCheckpoint", () => {
  it("parks the ticket and records the checkpoint request", () => {
    seedSimple("H1");
    const res = svc.requestHumanCheckpoint("H1", "need a decision", "agent", "decision") as any;
    expect(res.parked).toBe(true);
    const t = svc.getTicket("H1");
    expect(t.labels).toContain("awaiting-decision");
    expect(t.audit.some((e: any) => e.action === "human_checkpoint_requested")).toBe(true);
  });

  it("is idempotent — re-parking is a no-op", () => {
    seedSimple("H2");
    svc.requestHumanCheckpoint("H2", "x", "agent");
    const res = svc.requestHumanCheckpoint("H2", "x", "agent") as any;
    expect(res.parked).toBe(false);
    expect(res.reason).toBe("already_parked");
  });

  it("approve clears the gate and re-queues to backlog", () => {
    seedSimple("H3", "in-progress");
    svc.requestHumanCheckpoint("H3", "x", "agent");
    const res = svc.resolveHumanCheckpoint("H3", "approve", "human") as any;
    expect(res.ok).toBe(true);
    const t = svc.getTicket("H3");
    expect(t.labels).not.toContain("awaiting-decision");
    expect(t.status).toBe("backlog");
  });

  it("reject cancels the ticket", () => {
    seedSimple("H4", "review");
    svc.requestHumanCheckpoint("H4", "x", "agent");
    svc.resolveHumanCheckpoint("H4", "reject", "human");
    expect(svc.getTicket("H4").status).toBe("cancelled");
  });

  it("release clears the gate without changing status", () => {
    seedSimple("H5", "review");
    svc.requestHumanCheckpoint("H5", "x", "agent");
    svc.resolveHumanCheckpoint("H5", "release", "human");
    const t = svc.getTicket("H5");
    expect(t.labels).not.toContain("awaiting-decision");
    expect(t.status).toBe("review");
  });

  it("reject of the last open child auto-completes the parent epic", () => {
    // Rejecting a checkpoint cancels the child (service.ts:835 routes through
    // maybeCompleteParentEpic). When that child is the epic's last open child,
    // the parent must roll up to done — the human-checkpoint reject path is the
    // only caller of that branch left untested.
    const now = new Date().toISOString();
    fakeDb._tickets.set("EPIC", {
      id: "EPIC", title: "epic", status: "in-progress", reviewPhase: null,
      labels: [], blockedBy: [], comments: [], audit: [], parentId: null,
      createdAt: now, updatedAt: now, closedAt: null,
    });
    fakeDb._tickets.set("CHILD", {
      id: "CHILD", title: "child", status: "review", reviewPhase: null,
      labels: [], blockedBy: [], comments: [], audit: [], parentId: "EPIC",
      createdAt: now, updatedAt: now, closedAt: null,
    });

    svc.requestHumanCheckpoint("CHILD", "x", "agent");
    svc.resolveHumanCheckpoint("CHILD", "reject", "human");

    expect(svc.getTicket("CHILD").status).toBe("cancelled");
    const epic = svc.getTicket("EPIC");
    expect(epic.status).toBe("done");
    expect(epic.audit.some((e: any) => e.action === "epic_auto_completed")).toBe(true);
  });
});

// ── #1 Crash recovery ─────────────────────────────────────────────────────────

describe("recoverStuckTicket", () => {
  it("forces an in-progress ticket to blocked and raises a human checkpoint", () => {
    seedSimple("R1", "in-progress");
    const res = svc.recoverStuckTicket("R1", "agent crashed", "ticket-watcher") as any;
    expect(res.recovered).toBe(true);
    const t = svc.getTicket("R1");
    expect(t.status).toBe("blocked");
    // A crash is surfaced as a human checkpoint and recorded on the trail.
    expect(t.labels).toContain("awaiting-decision");
    expect(t.audit.some((e: any) => e.action === "recovered_stuck")).toBe(true);
    expect(t.audit.some((e: any) => e.action === "human_checkpoint_requested")).toBe(true);
  });

  it("recovers a rework ticket too", () => {
    seedSimple("R2", "rework");
    expect((svc.recoverStuckTicket("R2", "x", "w") as any).recovered).toBe(true);
    expect(svc.getTicket("R2").status).toBe("blocked");
  });

  it("no-ops a ticket that already moved on (not in flight)", () => {
    seedSimple("R3", "review"); // worker reported progress before dying
    const res = svc.recoverStuckTicket("R3", "x", "w") as any;
    expect(res.recovered).toBe(false);
    expect(res.reason).toBe("not_in_flight");
    expect(svc.getTicket("R3").status).toBe("review");
  });

  it("errors on a missing ticket", () => {
    expect((svc.recoverStuckTicket("nope", "x", "w") as any).error).toMatch(/not found/);
  });
});
