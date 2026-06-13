// Tests for db.ts listTickets / listSprints advanced filter paths.
//
// db.test.ts covers basic CRUD and status filters.  This file covers the
// remaining filter branches that hit distinct SQL code paths:
//   - listTickets({ label })   — unique json_each SQL rewrite
//   - listTickets({ assigneeId })
//   - listTickets({ priority })
//   - listTickets({ sprintId })
//   - listSprints({ teamId })
//   - listSprints({ daemonId })
//
// Each test gets its own unique ids so it doesn't clash with parallel suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

// ── workspace bootstrap ────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-filters-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── factories ──────────────────────────────────────────────────────────────

let seq = 0;
const PREFIX = "dbf"; // "db filters" — avoids id collisions with db.test.ts
function uid() { return `${PREFIX}-${Date.now()}-${++seq}`; }

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${uid()}`,
    title: "Filter test ticket",
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
    name: "Filter Sprint",
    status: "planning",
    ticketIds: [] as string[],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── listTickets — label filter (json_each SQL rewrite) ─────────────────────

describe("listTickets — label filter", () => {
  it("returns only tickets that carry the requested label", () => {
    const withLabel    = makeTicket({ labels: ["bug", "urgent"] });
    const otherLabel   = makeTicket({ labels: ["feature"] });
    const noLabels     = makeTicket({ labels: [] });
    db.saveTicket(withLabel);
    db.saveTicket(otherLabel);
    db.saveTicket(noLabels);

    const results = db.listTickets({ label: "bug" });
    const ids = results.map((t: any) => t.id);
    expect(ids).toContain(withLabel.id);
    expect(ids).not.toContain(otherLabel.id);
    expect(ids).not.toContain(noLabels.id);
  });

  it("returns multiple tickets that share the same label", () => {
    const a = makeTicket({ labels: ["security"] });
    const b = makeTicket({ labels: ["security", "urgent"] });
    db.saveTicket(a);
    db.saveTicket(b);

    const results = db.listTickets({ label: "security" });
    const ids = results.map((t: any) => t.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("returns empty array when no ticket has that label", () => {
    const results = db.listTickets({ label: "label-that-does-not-exist-xyzzy" });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});

// ── listTickets — assigneeId filter ────────────────────────────────────────

describe("listTickets — assigneeId filter", () => {
  it("returns only tickets assigned to the given agent", () => {
    const mine    = makeTicket({ assigneeId: "agent-alice" });
    const others  = makeTicket({ assigneeId: "agent-bob" });
    const noAssign = makeTicket({});
    db.saveTicket(mine);
    db.saveTicket(others);
    db.saveTicket(noAssign);

    const results = db.listTickets({ assigneeId: "agent-alice" });
    const ids = results.map((t: any) => t.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(others.id);
    expect(ids).not.toContain(noAssign.id);
  });
});

// ── listTickets — priority filter ──────────────────────────────────────────

describe("listTickets — priority filter", () => {
  it("returns only tickets with the given priority", () => {
    const high   = makeTicket({ priority: "high" });
    const low    = makeTicket({ priority: "low" });
    db.saveTicket(high);
    db.saveTicket(low);

    const results = db.listTickets({ priority: "high" });
    const ids = results.map((t: any) => t.id);
    expect(ids).toContain(high.id);
    expect(ids).not.toContain(low.id);
    expect(results.every((t: any) => t.priority === "high")).toBe(true);
  });
});

// ── listTickets — sprintId filter ──────────────────────────────────────────

describe("listTickets — sprintId filter", () => {
  it("returns only tickets belonging to the given sprint", () => {
    const sprintId = `sprint-${uid()}`;
    const inSprint  = makeTicket({ sprintId });
    const noSprint  = makeTicket({});
    db.saveTicket(inSprint);
    db.saveTicket(noSprint);

    const results = db.listTickets({ sprintId });
    const ids = results.map((t: any) => t.id);
    expect(ids).toContain(inSprint.id);
    expect(ids).not.toContain(noSprint.id);
    expect(results.every((t: any) => t.sprintId === sprintId)).toBe(true);
  });
});

// ── listSprints — teamId filter ────────────────────────────────────────────

describe("listSprints — teamId filter", () => {
  it("returns only sprints owned by the given team", () => {
    const teamId = `team-${uid()}`;
    const inTeam  = makeSprint({ teamId });
    const other   = makeSprint({ teamId: `team-other-${uid()}` });
    db.saveSprint(inTeam);
    db.saveSprint(other);

    const results = db.listSprints({ teamId });
    const ids = results.map((s: any) => s.id);
    expect(ids).toContain(inTeam.id);
    expect(ids).not.toContain(other.id);
    expect(results.every((s: any) => s.teamId === teamId)).toBe(true);
  });
});

// ── listSprints — daemonId filter ──────────────────────────────────────────

describe("listSprints — daemonId filter", () => {
  it("returns only sprints associated with the given daemon", () => {
    const daemonId = `daemon-${uid()}`;
    const forDaemon  = makeSprint({ daemonId });
    const unowned    = makeSprint({});
    db.saveSprint(forDaemon);
    db.saveSprint(unowned);

    const results = db.listSprints({ daemonId });
    const ids = results.map((s: any) => s.id);
    expect(ids).toContain(forDaemon.id);
    expect(ids).not.toContain(unowned.id);
    expect(results.every((s: any) => s.daemonId === daemonId)).toBe(true);
  });
});
