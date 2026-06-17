// Tests for db.ts listTickets / listSprints ordering contract.
//
// db.test.ts and db-list-filters.test.ts cover CRUD, JSON round-trip, and every
// filter branch — but none assert the `ORDER BY updatedAt DESC` clause in
// _listTickets / _listSprints (db.ts lines 137 / 215). Callers (ticket lists,
// sprint boards) rely on newest-updated-first ordering, so this pins it.
//
// Deterministic: fixed ISO timestamps (ISO 8601 sorts lexicographically ==
// chronologically, matching the TEXT-column ORDER BY). Real SQLite under a tmp
// workspace — no network, no real Claude, no wall-clock dependence.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-ordering-test-"));
  // Pre-create tmpRoot/.zana so resolveProjectDir() stops here instead of
  // walking up to a shared /tmp/.zana with WAL-locked SQLite files.
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function uid() { return `${Date.now()}-${++seq}`; }

describe("db — listTickets ordering by updatedAt DESC", () => {
  it("returns tickets newest-updated first regardless of insertion order", () => {
    // Isolate this test's rows via a unique assigneeId filter so the assertion
    // is independent of any other rows in the same forked-process DB.
    const owner = `ordering-owner-${uid()}`;
    const base = {
      title: "Ordering ticket",
      status: "backlog",
      priority: "medium",
      labels: [] as string[],
      blockedBy: [] as string[],
      comments: [] as unknown[],
      audit: [] as unknown[],
      reworkCount: 0,
      assigneeId: owner,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const oldest = { ...base, id: `T-ord-old-${uid()}`, updatedAt: "2026-01-01T00:00:00.000Z" };
    const middle = { ...base, id: `T-ord-mid-${uid()}`, updatedAt: "2026-02-01T00:00:00.000Z" };
    const newest = { ...base, id: `T-ord-new-${uid()}`, updatedAt: "2026-03-01T00:00:00.000Z" };

    // Insert deliberately out of chronological order.
    db.saveTicket(middle);
    db.saveTicket(oldest);
    db.saveTicket(newest);

    const ids = db.listTickets({ assigneeId: owner }).map((t: any) => t.id);
    expect(ids).toEqual([newest.id, middle.id, oldest.id]);
  });
});

describe("db — listSprints ordering by updatedAt DESC", () => {
  it("returns sprints newest-updated first regardless of insertion order", () => {
    const team = `ordering-team-${uid()}`;
    const base = {
      name: "Ordering sprint",
      status: "planning",
      teamId: team,
      ticketIds: [] as string[],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const oldest = { ...base, id: `S-ord-old-${uid()}`, updatedAt: "2026-01-01T00:00:00.000Z" };
    const middle = { ...base, id: `S-ord-mid-${uid()}`, updatedAt: "2026-02-01T00:00:00.000Z" };
    const newest = { ...base, id: `S-ord-new-${uid()}`, updatedAt: "2026-03-01T00:00:00.000Z" };

    db.saveSprint(oldest);
    db.saveSprint(newest);
    db.saveSprint(middle);

    const ids = db.listSprints({ teamId: team }).map((s: any) => s.id);
    expect(ids).toEqual([newest.id, middle.id, oldest.id]);
  });
});
