// Tests the field-defaulting invariant of migrateIfNeeded().
//
// migration-json.test.ts covers the happy path with fully-populated tickets.
// This file pins the OTHER half of the contract: a minimal ticket JSON that
// omits every optional field must still land in the DB with the documented
// defaults (status=backlog, priority=medium, reworkCount=0, and empty JSON
// arrays for labels/blockedBy/comments/audit). Regressing any default would
// silently corrupt migrated tickets, so it deserves its own guard.
//
// Follows the temp-workspace pattern from migration-json.test.ts — all writes
// are confined to a per-test tmpdir and the in-memory DB leaves no disk state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { migrateIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

function createDatabase(): any {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog', priority TEXT DEFAULT 'medium',
      assigneeId TEXT, assigneeName TEXT, assigneeProfileId TEXT,
      reviewPhase TEXT, reworkCount INTEGER DEFAULT 0, sprintId TEXT,
      labels TEXT, blockedBy TEXT, type TEXT, comments TEXT, audit TEXT,
      createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      closedAt TEXT, resultSummary TEXT
    );
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, teamId TEXT, daemonId TEXT,
      status TEXT NOT NULL DEFAULT 'planning', ticketIds TEXT,
      startedAt TEXT, endedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
  `);
  return db;
}

const NOW = "2025-06-01T00:00:00.000Z";

let tmpRoot: string;
let ticketsDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migration-defaults-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
  ticketsDir = (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
  fs.mkdirSync(ticketsDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("migrateIfNeeded — field defaults for minimal tickets", () => {
  it("applies documented defaults when optional fields are omitted", () => {
    const db = createDatabase();
    // Only the required fields — everything else must be defaulted.
    const ticket = { id: "T-min", title: "Bare ticket", createdAt: NOW, updatedAt: NOW };
    fs.writeFileSync(path.join(ticketsDir, "T-min.json"), JSON.stringify(ticket));

    migrateIfNeeded(db);

    const row: any = db.prepare("SELECT * FROM tickets WHERE id = ?").get("T-min");
    expect(row).not.toBeNull();

    // Scalar defaults.
    expect(row.status).toBe("backlog");
    expect(row.priority).toBe("medium");
    expect(row.reworkCount).toBe(0);

    // Absent optional scalars are stored as NULL, not "undefined"/"".
    expect(row.description).toBeNull();
    expect(row.assigneeId).toBeNull();
    expect(row.reviewPhase).toBeNull();
    expect(row.sprintId).toBeNull();
    expect(row.closedAt).toBeNull();

    // JSON-array columns default to a serialized empty array (not NULL),
    // so downstream JSON.parse() never has to special-case them.
    expect(JSON.parse(row.labels)).toEqual([]);
    expect(JSON.parse(row.blockedBy)).toEqual([]);
    expect(JSON.parse(row.comments)).toEqual([]);
    expect(JSON.parse(row.audit)).toEqual([]);
  });
});
