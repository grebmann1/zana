// Tests for db.ts tenant-isolation gate in getDbPath() (db.ts lines 17-32).
//
// Other db.* test files all call workspaceContext.init(tmpRoot) in beforeAll,
// so they never exercise the refusal path. The documented invariant
// (CLAUDE.md "Workspace context — tenant isolation invariant"): when the
// workspace context is NOT initialized, the SQLite store must REFUSE to fall
// back to the shared ~/.zana/tickets.db and instead throw
// WorkspaceNotInitializedError — otherwise tickets from different workspaces
// silently mix on a shared host path.
//
// Deterministic: each vitest file is an isolated worker, so the module-level
// workspaceContext singleton starts uninitialized here. No init() is called.
// No network, no real Claude, no wall-clock dependence.

import { describe, it, expect } from "vitest";

import * as workspaceContext from "@zana-ai/contracts";
import * as db from "@zana-ai/work/src/tickets/db.ts";

// The gate only applies when the SQLite backend is active. If better-sqlite3
// is unavailable, db.* delegates to the JSON fallback store, which has its own
// path resolution — skip rather than assert a behavior db.ts isn't running.
let sqliteAvailable = true;
try { require("better-sqlite3"); } catch { sqliteAvailable = false; }

describe("db — tenant-isolation gate (uninitialized workspace)", () => {
  it("starts with an uninitialized workspace context in this worker", () => {
    expect(workspaceContext.isInitialized()).toBe(false);
  });

  // NOTE: assert on the stable `name`/`code` rather than `instanceof`. db.ts
  // throws the error class from the built `@zana-ai/core` (resolved via
  // lazyRequire of dist), which is a distinct class identity from the source
  // module imported above — so `instanceof` would spuriously fail.
  it.runIf(sqliteAvailable)(
    "refuses to open the DB and throws WorkspaceNotInitializedError",
    () => {
      let caught: any;
      try {
        db.getTicket("any-id");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.name).toBe("WorkspaceNotInitializedError");
      expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
    },
  );

  it.runIf(sqliteAvailable)(
    "names the refused operation and never points at the global ~/.zana path",
    () => {
      let caught: any;
      try {
        db.listTickets();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
      expect(caught.operation).toBe("open");
      // The refusal must reference tickets.db, not silently succeed.
      expect(String(caught.path)).toContain("tickets.db");
    },
  );
});
