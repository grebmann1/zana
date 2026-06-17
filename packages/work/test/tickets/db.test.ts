// Tests for packages/work/src/tickets/db.ts
//
// db.ts is a SQLite-backed store (better-sqlite3).  Each test file runs in its
// own process (vitest forks pool), so the module-level `_db` singleton starts
// fresh here.  A temp workspace is set up in beforeAll so the module resolves
// the DB path inside the temp tree, not in ~/.zana.
//
// Coverage: ticket CRUD (save/get/list/delete) + sprint CRUD + JSON-column
// round-trip (labels, comments, audit, ticketIds).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

// ── workspace bootstrap ────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-test-"));
  // Pre-create tmpRoot/.zana so resolveProjectDir() stops here instead of
  // walking up the filesystem and finding a shared /tmp/.zana directory that
  // may already have WAL-locked SQLite files from a running daemon.
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  // Initialize workspace context so db.ts resolves paths inside tmpRoot.
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── factories ──────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `${Date.now()}-${++seq}`; }

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${uid()}`,
    title: "Test ticket",
    status: "backlog",
    priority: "medium",
    labels: [] as string[],
    blockedBy: [] as string[],
    comments: [] as unknown[],
    audit: [] as unknown[],
    reworkCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSprint(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `S-${uid()}`,
    name: "Sprint 1",
    status: "planning",
    ticketIds: [] as string[],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── ticket CRUD ────────────────────────────────────────────────────────────

describe("db — ticket save / get round-trip", () => {
  it("persists a ticket and retrieves it by id", () => {
    const t = makeTicket({ title: "Round-trip ticket" });
    db.saveTicket(t);
    const got = db.getTicket(t.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(t.id);
    expect(got!.title).toBe("Round-trip ticket");
    expect(got!.status).toBe("backlog");
  });

  it("getTicket returns null for unknown id", () => {
    expect(db.getTicket("no-such-ticket-xyz")).toBeNull();
  });

  it("saveTicket acts as upsert — updates an existing ticket", () => {
    const t = makeTicket({ title: "Original" });
    db.saveTicket(t);
    db.saveTicket({ ...t, title: "Updated" });
    const got = db.getTicket(t.id);
    expect(got!.title).toBe("Updated");
  });
});

describe("db — ticket JSON column round-trip", () => {
  it("serialises and deserialises labels, blockedBy, comments, audit", () => {
    const t = makeTicket({
      labels: ["bug", "urgent"],
      blockedBy: ["T-other"],
      comments: [{ ts: "2026-01-01T00:00:00Z", text: "first comment" }],
      audit: [{ ts: "2026-01-01T00:00:00Z", action: "created" }],
    });
    db.saveTicket(t);
    const got = db.getTicket(t.id);
    expect(got!.labels).toEqual(["bug", "urgent"]);
    expect(got!.blockedBy).toEqual(["T-other"]);
    expect(got!.comments).toEqual([{ ts: "2026-01-01T00:00:00Z", text: "first comment" }]);
    expect(got!.audit).toEqual([{ ts: "2026-01-01T00:00:00Z", action: "created" }]);
  });

  it("defaults empty arrays when columns contain null / empty JSON", () => {
    // Save a minimal ticket (no labels etc.) and check defaults come back.
    const t = makeTicket();
    db.saveTicket(t);
    const got = db.getTicket(t.id);
    expect(Array.isArray(got!.labels)).toBe(true);
    expect(Array.isArray(got!.comments)).toBe(true);
    expect(Array.isArray(got!.audit)).toBe(true);
  });
});

describe("db — listTickets", () => {
  it("returns all saved tickets (unfiltered)", () => {
    const a = makeTicket({ status: "backlog" });
    const b = makeTicket({ status: "in-progress" });
    db.saveTicket(a);
    db.saveTicket(b);
    const list = db.listTickets();
    expect(list.some((x: any) => x.id === a.id)).toBe(true);
    expect(list.some((x: any) => x.id === b.id)).toBe(true);
  });

  it("filters by status", () => {
    const done = makeTicket({ status: "done" });
    db.saveTicket(done);
    const results = db.listTickets({ status: "done" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((x: any) => x.status === "done")).toBe(true);
    expect(results.some((x: any) => x.id === done.id)).toBe(true);
  });
});

describe("db — deleteTicket", () => {
  it("removes the ticket and returns true", () => {
    const t = makeTicket();
    db.saveTicket(t);
    expect(db.deleteTicket(t.id)).toBe(true);
    expect(db.getTicket(t.id)).toBeNull();
  });

  it("returns false when the ticket does not exist", () => {
    expect(db.deleteTicket("ghost-ticket-never-existed")).toBe(false);
  });
});

// ── sprint CRUD ────────────────────────────────────────────────────────────

describe("db — sprint save / get round-trip", () => {
  it("persists a sprint and retrieves it by id", () => {
    const s = makeSprint({ name: "Alpha Sprint" });
    db.saveSprint(s);
    const got = db.getSprint(s.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(s.id);
    expect(got!.name).toBe("Alpha Sprint");
    expect(got!.ticketIds).toEqual([]);
  });

  it("getSprint returns null for unknown id", () => {
    expect(db.getSprint("no-such-sprint-xyz")).toBeNull();
  });

  it("serialises and deserialises ticketIds", () => {
    const s = makeSprint({ ticketIds: ["T-1", "T-2", "T-3"] });
    db.saveSprint(s);
    const got = db.getSprint(s.id);
    expect(got!.ticketIds).toEqual(["T-1", "T-2", "T-3"]);
  });
});

describe("db — listSprints", () => {
  it("returns saved sprints", () => {
    const s = makeSprint();
    db.saveSprint(s);
    const list = db.listSprints();
    expect(list.some((x: any) => x.id === s.id)).toBe(true);
  });

  it("filters by status", () => {
    const active = makeSprint({ status: "active" });
    db.saveSprint(active);
    const results = db.listSprints({ status: "active" });
    expect(results.every((x: any) => x.status === "active")).toBe(true);
    expect(results.some((x: any) => x.id === active.id)).toBe(true);
  });
});

describe("db — deleteSprint", () => {
  it("removes the sprint and returns true", () => {
    const s = makeSprint();
    db.saveSprint(s);
    expect(db.deleteSprint(s.id)).toBe(true);
    expect(db.getSprint(s.id)).toBeNull();
  });

  it("returns false when the sprint does not exist", () => {
    expect(db.deleteSprint("ghost-sprint-never-existed")).toBe(false);
  });
});
