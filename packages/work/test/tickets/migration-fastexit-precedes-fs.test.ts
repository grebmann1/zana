// Gate-ordering test for migrateIfNeeded (packages/work/src/tickets/migration.ts).
//
// migration.ts checks the row-count guard FIRST:
//   if (ticketCount > 0) return;
//   const tickets = loadJsonTickets();   // <-- only reached when DB is empty
// loadJsonTickets()/loadJsonSprints() call getTicketsDir()/getSprintsDir(),
// which resolve the workspace via core.project.workspaceContext (isInitialized
// then getProjectPaths, or throw WorkspaceNotInitializedError). The existing
// "fast-exit" test asserts no-throw + unchanged row count, but it does NOT
// prove the count-guard runs BEFORE any workspace/filesystem access — so a
// regression that reordered the guard after loadJsonTickets() (re-importing
// JSON over a populated DB, or throwing WorkspaceNotInitializedError on a
// healthy DB) would still pass. This pins the ordering the same way the repo
// pins other precedence invariants (e.g. store-falsy-id-precedes-workspace-gate).
//
// We spy on the live CJS core.project.workspaceContext object (the same
// approach the interval error-logging test uses on core.util.logger): if the
// guard short-circuits, isInitialized()/getProjectPaths() are never reached.
//
// Deterministic: in-memory better-sqlite3, stubbed workspace context, no
// disk/network.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as coreNs from "@zana-ai/core";
import { migrateIfNeeded } from "@zana-ai/work/src/tickets/migration.ts";

// CJS interop: the package is `module.exports = {...}`.
const core: any = (coreNs as any).default ?? coreNs;

function createDatabase(): any {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function createTicketsTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

describe("migrateIfNeeded — row-count guard precedes workspace/fs access", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("never resolves the workspace when the tickets table already has rows", () => {
    const db = createDatabase();
    createTicketsTable(db);
    db.prepare(`INSERT INTO tickets (id, title, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?)`).run(
      "T-1", "Existing ticket", "backlog",
      "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
    );

    const wc = core.project.workspaceContext;
    const isInitSpy = vi.spyOn(wc, "isInitialized");
    const getPathsSpy = vi.spyOn(wc, "getProjectPaths");

    expect(() => migrateIfNeeded(db)).not.toThrow();

    // The guard short-circuits before loadJsonTickets()/loadJsonSprints(),
    // so the workspace context is never consulted.
    expect(isInitSpy).not.toHaveBeenCalled();
    expect(getPathsSpy).not.toHaveBeenCalled();

    // And the populated DB is left untouched (no re-import).
    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    expect(cnt.c).toBe(1);
  });
});
