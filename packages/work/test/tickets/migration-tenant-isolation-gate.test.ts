// Tests the tenant-isolation gate in migration.ts (getTicketsDir/getSprintsDir,
// src lines 4-27).
//
// Every other migration.* test calls workspaceContext.init(tmpRoot) (directly
// or via a temp-workspace helper), so none exercises the refusal path. The
// documented invariant (CLAUDE.md "Workspace context — tenant isolation
// invariant", and the src comments): when the workspace context is NOT
// initialized, migrateIfNeeded must REFUSE to read from the shared
// ~/.zana/tickets directory and instead throw WorkspaceNotInitializedError —
// otherwise a migration would mix tickets across tenants on a shared host.
//
// The early `SELECT COUNT(*)` exit only fires when the tickets table already
// has rows; with an EMPTY table migrateIfNeeded proceeds to loadJsonTickets()
// → getTicketsDir(), which is where the gate must trip.
//
// Deterministic: each vitest file is an isolated worker, so the module-level
// workspaceContext singleton starts uninitialized here. No init() is called,
// no network, no real Claude, no wall-clock dependence. The DB is in-memory.

import { describe, it, expect } from "vitest";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import { migrateIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

// better-sqlite3 is a CJS native module; require() avoids ESM import issues.
let sqliteAvailable = true;
try { require("better-sqlite3"); } catch { sqliteAvailable = false; }

function createEmptyTicketsDb(): any {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Minimal schema — migrateIfNeeded only needs to COUNT rows before it
  // reaches the filesystem read that the gate guards.
  db.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT,
      createdAt TEXT, updatedAt TEXT
    );
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, daemonId TEXT,
      createdAt TEXT, updatedAt TEXT
    );
  `);
  return db;
}

describe("migrateIfNeeded — tenant-isolation gate (uninitialized workspace)", () => {
  it("starts with an uninitialized workspace context in this worker", () => {
    expect(workspaceContext.isInitialized()).toBe(false);
  });

  // NOTE: assert on the stable `name`/`code` rather than `instanceof`. The error
  // class is resolved via lazyRequire of the built @zana-ai/core (dist), which
  // is a distinct class identity from the source module — so `instanceof` would
  // spuriously fail. Same caveat documented in db-tenant-isolation-gate.test.ts.
  it.runIf(sqliteAvailable)(
    "refuses to read the global tickets dir and throws WorkspaceNotInitializedError",
    () => {
      const db = createEmptyTicketsDb();
      try {
        let caught: any;
        try {
          migrateIfNeeded(db);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(caught.name).toBe("WorkspaceNotInitializedError");
        expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
        // Refusal must reference the tickets path, never silently succeed.
        expect(String(caught.path)).toContain("tickets");
        // The empty tickets table must remain untouched — no partial migration.
        expect(db.prepare("SELECT COUNT(*) AS cnt FROM tickets").get().cnt).toBe(0);
      } finally {
        db.close();
      }
    },
  );
});
