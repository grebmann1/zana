// Focused regression guard for loadJsonTickets() inside migrateIfNeeded().
//
// src/tickets/migration.ts skips entries whose name starts with "_" BEFORE it
// branches on entry.isDirectory():
//
//     if (entry.name.startsWith("_")) continue;
//     ...
//     if (entry.isDirectory()) { ...read <dir>/ticket.json... }
//
// The existing migration-json suite pins the two halves of this in isolation:
//   - "ignores _-prefixed files"      → an underscore *file* (_index.json)
//   - "migrates a directory-format ticket" → a NON-underscore *directory*
// What no test exercises is their intersection: an underscore-prefixed
// *directory* that itself contains a perfectly valid ticket.json. Because the
// prefix guard sits ahead of the directory branch, such a directory must be
// skipped wholesale — its ticket.json is never read. A refactor that moved the
// "_" guard below the isDirectory() handling (so it only filtered flat files)
// would migrate these archival/internal directories and slip past every
// current test. This locks the guard's applicability to directory entries.
//
// Deterministic: in-memory SQLite + a per-test tmp workspace, no network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { migrateIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

const NOW = "2025-06-01T00:00:00.000Z";

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

let tmpRoot: string;
let ticketsDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migration-underscore-dir-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
  ticketsDir = (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
  fs.mkdirSync(ticketsDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("migrateIfNeeded — _-prefixed directories are skipped before the directory branch", () => {
  it("skips a _-prefixed directory containing a valid ticket.json, but still migrates a sibling normal directory ticket", () => {
    const db = createDatabase();

    // An underscore-prefixed directory with a fully valid ticket.json inside.
    // The "_" guard fires on the directory entry, so this ticket.json is
    // never read — the ticket must NOT land in the table.
    const archiveDir = path.join(ticketsDir, "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "ticket.json"),
      JSON.stringify({ id: "T-archived", title: "Archived ticket", createdAt: NOW, updatedAt: NOW }),
    );

    // A normal directory-format ticket that SHOULD migrate — proves the run
    // wasn't a global no-op and the directory branch still works.
    const goodDir = path.join(ticketsDir, "T-dir-good");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, "ticket.json"),
      JSON.stringify({ id: "T-dir-good", title: "Valid dir ticket", createdAt: NOW, updatedAt: NOW }),
    );

    migrateIfNeeded(db);

    const ids = db
      .prepare("SELECT id FROM tickets ORDER BY id")
      .all()
      .map((r: any) => r.id);
    expect(ids).toEqual(["T-dir-good"]);
  });
});
