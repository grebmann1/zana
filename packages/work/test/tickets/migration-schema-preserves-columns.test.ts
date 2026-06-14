// Focused regression guard for packages/work/src/tickets/migration.ts.
//
// migrateSchemaIfNeeded rebuilds the `sprints` table (CREATE sprints_new +
// INSERT ... SELECT + DROP + RENAME) to rename the legacy `hiveId` column to
// `daemonId`. The existing migration.test.ts only asserts that `daemonId`
// carries across — it never checks the OTHER columns. Because the rebuild
// relies on a positional column list in the INSERT...SELECT, a future edit
// that reorders the column list (in either the CREATE or the SELECT) would
// silently scramble row data into the wrong columns and no test would catch
// it. This test locks the full-row-preservation invariant.

import { describe, it, expect } from "vitest";
import { migrateSchemaIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

function createDatabase(): any {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Legacy schema: hiveId column, no daemonId. */
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

describe("migrateSchemaIfNeeded — full-row preservation through rebuild", () => {
  it("carries every sprint column across the hiveId→daemonId rebuild, not just daemonId", () => {
    const db = createDatabase();
    createLegacySprintsTable(db);

    const original = {
      id: "s-full",
      name: "Migration Sprint",
      teamId: "team-7",
      hiveId: "daemon-legacy",
      status: "active",
      ticketIds: JSON.stringify(["T-1", "T-2", "T-3"]),
      startedAt: "2025-02-01T08:00:00.000Z",
      endedAt: "2025-02-14T17:30:00.000Z",
      createdAt: "2025-01-15T00:00:00.000Z",
      updatedAt: "2025-02-14T17:30:00.000Z",
    };

    db.prepare(
      `INSERT INTO sprints (id, name, teamId, hiveId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt)
       VALUES (@id, @name, @teamId, @hiveId, @status, @ticketIds, @startedAt, @endedAt, @createdAt, @updatedAt)`,
    ).run(original);

    migrateSchemaIfNeeded(db);

    // Column was renamed.
    const colNames = db
      .prepare("PRAGMA table_info(sprints)")
      .all()
      .map((c: any) => c.name);
    expect(colNames).toContain("daemonId");
    expect(colNames).not.toContain("hiveId");

    // Every value landed in its correct column (no positional scrambling).
    const row: any = db
      .prepare("SELECT * FROM sprints WHERE id = 's-full'")
      .get();
    expect(row).toMatchObject({
      id: original.id,
      name: original.name,
      teamId: original.teamId,
      daemonId: original.hiveId, // hiveId value now under daemonId
      status: original.status,
      ticketIds: original.ticketIds,
      startedAt: original.startedAt,
      endedAt: original.endedAt,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });
    // ticketIds must remain valid JSON after the round-trip.
    expect(JSON.parse(row.ticketIds)).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("renames the column even when the legacy table has no rows", () => {
    const db = createDatabase();
    createLegacySprintsTable(db);

    migrateSchemaIfNeeded(db);

    const colNames = db
      .prepare("PRAGMA table_info(sprints)")
      .all()
      .map((c: any) => c.name);
    expect(colNames).toContain("daemonId");
    expect(colNames).not.toContain("hiveId");

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM sprints").get();
    expect(cnt.c).toBe(0);
  });
});
