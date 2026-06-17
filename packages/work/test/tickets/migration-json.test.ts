// Tests for the JSON-to-SQLite migration path of migrateIfNeeded().
//
// The existing migration.test.ts intentionally skips this path because it
// requires a live filesystem + workspace context.  These tests supply both
// via a temp workspace, matching the pattern used by store.test.ts and
// db.test.ts.  All writes are confined to a per-test tmpdir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { migrateIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

// ── helpers ────────────────────────────────────────────────────────────────

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migration-json-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
  ticketsDir = (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
  fs.mkdirSync(ticketsDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("migrateIfNeeded — JSON-to-SQLite migration", () => {
  it("migrates a flat .json ticket file into the tickets table", () => {
    const db = createDatabase();
    const ticket = {
      id: "T-flat-1", title: "Flat file ticket", status: "in-progress",
      priority: "high", labels: ["bug", "urgent"], comments: [], audit: [],
      createdAt: NOW, updatedAt: NOW,
    };
    fs.writeFileSync(path.join(ticketsDir, "T-flat-1.json"), JSON.stringify(ticket));

    migrateIfNeeded(db);

    const row: any = db.prepare("SELECT * FROM tickets WHERE id = ?").get("T-flat-1");
    expect(row).not.toBeNull();
    expect(row.title).toBe("Flat file ticket");
    expect(row.status).toBe("in-progress");
    expect(row.priority).toBe("high");
    expect(JSON.parse(row.labels)).toEqual(["bug", "urgent"]);
  });

  it("migrates a directory-format ticket (ticketDir/ticket.json)", () => {
    const db = createDatabase();
    const ticket = { id: "T-dir-1", title: "Dir format ticket", createdAt: NOW, updatedAt: NOW };
    const subDir = path.join(ticketsDir, "T-dir-1");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "ticket.json"), JSON.stringify(ticket));

    migrateIfNeeded(db);

    const row: any = db.prepare("SELECT id, title FROM tickets WHERE id = ?").get("T-dir-1");
    expect(row).not.toBeNull();
    expect(row.title).toBe("Dir format ticket");
  });

  it("ignores _-prefixed files and silently skips malformed JSON", () => {
    const db = createDatabase();
    const good = { id: "T-good", title: "Good ticket", createdAt: NOW, updatedAt: NOW };
    fs.writeFileSync(path.join(ticketsDir, "T-good.json"), JSON.stringify(good));
    fs.writeFileSync(path.join(ticketsDir, "_index.json"), JSON.stringify({ ignored: true }));
    fs.writeFileSync(path.join(ticketsDir, "corrupt.json"), "{ not valid json {{");

    migrateIfNeeded(db);

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(1);
    const row: any = db.prepare("SELECT id FROM tickets").get();
    expect(row.id).toBe("T-good");
  });

  it("skips a directory-format ticket whose ticket.json is malformed or missing", () => {
    // Exercises the directory branch's `catch { continue }` (src line 42) and the
    // "no ticket.json in the dir" path — distinct from the flat-file corrupt case.
    const db = createDatabase();

    // A valid directory-format ticket that SHOULD migrate.
    const goodDir = path.join(ticketsDir, "T-dir-good");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, "ticket.json"),
      JSON.stringify({ id: "T-dir-good", title: "Valid dir ticket", createdAt: NOW, updatedAt: NOW }),
    );

    // A directory whose ticket.json is corrupt — must be silently skipped.
    const corruptDir = path.join(ticketsDir, "T-dir-corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "ticket.json"), "{ broken json ::");

    // A directory with no ticket.json at all — readFileSync throws, caught, skipped.
    fs.mkdirSync(path.join(ticketsDir, "T-dir-empty"), { recursive: true });

    migrateIfNeeded(db);

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(1);
    const row: any = db.prepare("SELECT id FROM tickets").get();
    expect(row.id).toBe("T-dir-good");
  });

  it("is a no-op when the tickets dir is empty (avoids double-migration)", () => {
    const db = createDatabase();
    // ticketsDir exists but contains no usable files
    migrateIfNeeded(db);
    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(0);
  });

  it("is a no-op when the tickets table already contains rows", () => {
    const db = createDatabase();
    db.prepare("INSERT INTO tickets (id,title,status,createdAt,updatedAt) VALUES (?,?,?,?,?)")
      .run("T-existing", "Pre-existing", "backlog", NOW, NOW);
    // Write a JSON file that would be migrated if the guard didn't fire
    const extra = { id: "T-extra", title: "Should NOT migrate", createdAt: NOW, updatedAt: NOW };
    fs.writeFileSync(path.join(ticketsDir, "T-extra.json"), JSON.stringify(extra));

    migrateIfNeeded(db);

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(1); // still just the pre-existing row
  });
});
