// Tests for packages/work/src/tickets/migration.ts
//
// Only `migrateSchemaIfNeeded` and the fast-exit paths of `migrateIfNeeded`
// are covered here — both are pure DB operations with no file-system or
// workspace-context dependency.  An in-memory better-sqlite3 DB is used so
// tests are deterministic and leave no disk state.

import { describe, it, expect } from "vitest";
import { migrateIfNeeded, migrateSchemaIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDatabase(): any {
  // better-sqlite3 is a CJS native module — require() avoids ESM import issues.
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Create the "new" sprints schema (daemonId, no hiveId). */
function createNewSprintsTable(db: any) {
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teamId TEXT,
      daemonId TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      ticketIds TEXT,
      startedAt TEXT,
      endedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

/** Create the "legacy" sprints schema (hiveId, no daemonId). */
function createLegacySprintsTable(db: any) {
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teamId TEXT,
      hiveId TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      ticketIds TEXT,
      startedAt TEXT,
      endedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

function createTicketsTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT DEFAULT 'medium',
      assigneeId TEXT,
      assigneeName TEXT,
      assigneeProfileId TEXT,
      reviewPhase TEXT,
      reworkCount INTEGER DEFAULT 0,
      sprintId TEXT,
      labels TEXT,
      blockedBy TEXT,
      type TEXT,
      comments TEXT,
      audit TEXT,
      createdBy TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      closedAt TEXT,
      resultSummary TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// migrateSchemaIfNeeded
// ---------------------------------------------------------------------------

describe("migrateSchemaIfNeeded — legacy hiveId → daemonId", () => {
  it("renames hiveId to daemonId when only hiveId is present", () => {
    const db = createDatabase();
    createLegacySprintsTable(db);

    // Insert a row with hiveId set.
    db.prepare(`INSERT INTO sprints (id, name, hiveId, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?)`).run(
      "s1", "Sprint 1", "daemon-abc", "planning",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );

    migrateSchemaIfNeeded(db);

    // After migration the column is named 'daemonId'.
    const cols: any[] = db.prepare("PRAGMA table_info(sprints)").all();
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("daemonId");
    expect(colNames).not.toContain("hiveId");

    // And the data was carried across.
    const row: any = db.prepare("SELECT daemonId FROM sprints WHERE id = 's1'").get();
    expect(row.daemonId).toBe("daemon-abc");
  });

  it("is idempotent when daemonId already exists (no hiveId)", () => {
    const db = createDatabase();
    createNewSprintsTable(db);

    db.prepare(`INSERT INTO sprints (id, name, daemonId, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?)`).run(
      "s2", "Sprint 2", "daemon-xyz", "active",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );

    // Should be a no-op — no throw, table unchanged.
    expect(() => migrateSchemaIfNeeded(db)).not.toThrow();

    const row: any = db.prepare("SELECT daemonId FROM sprints WHERE id = 's2'").get();
    expect(row.daemonId).toBe("daemon-xyz");
  });

  it("coalesces hiveId and daemonId when both columns exist", () => {
    const db = createDatabase();
    // Manually create a hybrid table (both columns coexist — abnormal but
    // must be handled without data loss).
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        teamId TEXT,
        hiveId TEXT,
        daemonId TEXT,
        status TEXT NOT NULL DEFAULT 'planning',
        ticketIds TEXT,
        startedAt TEXT,
        endedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    db.prepare(`INSERT INTO sprints (id, name, hiveId, daemonId, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "s3", "Sprint 3", "hive-1", null, "planning",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );
    db.prepare(`INSERT INTO sprints (id, name, hiveId, daemonId, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "s4", "Sprint 4", null, "daemon-2", "planning",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );

    migrateSchemaIfNeeded(db);

    const cols: any[] = db.prepare("PRAGMA table_info(sprints)").all();
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("daemonId");
    expect(colNames).not.toContain("hiveId");

    const s3: any = db.prepare("SELECT daemonId FROM sprints WHERE id = 's3'").get();
    expect(s3.daemonId).toBe("hive-1");   // fell back to hiveId via COALESCE

    const s4: any = db.prepare("SELECT daemonId FROM sprints WHERE id = 's4'").get();
    expect(s4.daemonId).toBe("daemon-2"); // daemonId took precedence
  });

  it("is safe when the sprints table does not exist yet", () => {
    const db = createDatabase();
    expect(() => migrateSchemaIfNeeded(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// migrateIfNeeded — fast-exit paths (no workspace/fs dependency)
// ---------------------------------------------------------------------------

describe("migrateIfNeeded — fast-exit paths", () => {
  it("skips migration when the tickets table already has rows", () => {
    const db = createDatabase();
    createTicketsTable(db);
    createNewSprintsTable(db);

    // Pre-populate one ticket so the guard short-circuits.
    db.prepare(`INSERT INTO tickets (id, title, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?)`).run(
      "T-1", "Existing ticket", "backlog",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );

    // Should return immediately without throwing.
    expect(() => migrateIfNeeded(db)).not.toThrow();

    // Row count is still 1 (nothing was added or removed).
    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(1);
  });
});
