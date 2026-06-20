// Focused regression guard for packages/work/src/tickets/migration.ts.
//
// migrateSchemaIfNeeded now performs an additive ALTER TABLE on the `tickets`
// table for the epic/parent hierarchy (#4): older DBs predate the `parentId`
// column, so the migration adds it (plus the idx_tickets_parent index) when
// missing. The existing schema tests only cover the sprints hiveId→daemonId
// rebuild — nothing exercises the tickets parentId upgrade. This locks the
// additive-column invariant: the column appears, the index is created, existing
// rows survive (reading back parentId=null), and re-running is a safe no-op.
//
// An in-memory better-sqlite3 DB keeps the test deterministic with no disk state.

import { describe, it, expect } from "vitest";
import { migrateSchemaIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

function createDatabase(): any {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Legacy tickets schema: no `parentId` column (and no `workRef`). */
function createLegacyTicketsTable(db: any) {
  db.exec(`
    CREATE TABLE tickets (
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

function insertLegacyTicket(db: any, id: string) {
  db.prepare(
    `INSERT INTO tickets (id, title, status, priority, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "Legacy ticket", "in-progress", "high",
    "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z");
}

const colNames = (db: any) =>
  db.prepare("PRAGMA table_info(tickets)").all().map((c: any) => c.name);

describe("migrateSchemaIfNeeded — tickets parentId additive upgrade", () => {
  it("adds the parentId column and idx_tickets_parent index to a legacy table", () => {
    const db = createDatabase();
    createLegacyTicketsTable(db);
    expect(colNames(db)).not.toContain("parentId");

    migrateSchemaIfNeeded(db);

    expect(colNames(db)).toContain("parentId");
    const indexes = db
      .prepare("PRAGMA index_list(tickets)")
      .all()
      .map((i: any) => i.name);
    expect(indexes).toContain("idx_tickets_parent");
  });

  it("preserves existing rows and reads back parentId as null after upgrade", () => {
    const db = createDatabase();
    createLegacyTicketsTable(db);
    insertLegacyTicket(db, "T-legacy");

    migrateSchemaIfNeeded(db);

    const row: any = db.prepare("SELECT * FROM tickets WHERE id = 'T-legacy'").get();
    expect(row.title).toBe("Legacy ticket");
    expect(row.status).toBe("in-progress");
    expect(row.priority).toBe("high");
    // The new column defaults to NULL for pre-existing rows.
    expect(row.parentId).toBeNull();
  });

  it("is idempotent — a second run does not throw and leaves data intact", () => {
    const db = createDatabase();
    createLegacyTicketsTable(db);
    insertLegacyTicket(db, "T-idem");

    migrateSchemaIfNeeded(db);
    expect(() => migrateSchemaIfNeeded(db)).not.toThrow();

    // Column added exactly once (no duplicate from the second run).
    expect(colNames(db).filter((c: string) => c === "parentId")).toHaveLength(1);
    const row: any = db.prepare("SELECT parentId FROM tickets WHERE id = 'T-idem'").get();
    expect(row.parentId).toBeNull();
  });

  it("is safe when the tickets table does not exist yet", () => {
    const db = createDatabase();
    expect(() => migrateSchemaIfNeeded(db)).not.toThrow();
  });
});
