// Tenant-isolation gate regression tests for tickets/{db,store,migration}.
//
// All three modules used to silently fall back to ~/.zana/{tickets,sprints,
// tickets.db} when workspaceContext.isInitialized() was false. That fallback
// is shared across every workspace on the host — landing tickets there
// silently mixes work-tracking state across tenants. The gate refuses the
// fallback by throwing WorkspaceNotInitializedError.
//
// Each test runs in a fresh forked process (vitest forks pool), so the
// db.ts module-level `_db` singleton has not been touched and the gate
// surface is reachable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as migration from "@zana-ai/work/src/tickets/migration.ts";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";
import * as store from "@zana-ai/work/src/tickets/store.ts";

const wcDist: any = (core as any).project.workspaceContext;
const WorkspaceNotInitializedError = wcDist.WorkspaceNotInitializedError;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

describe("tickets tenant-isolation gate", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetWorkspace();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-tickets-iso-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  // ─── db.ts (SQLite) ──────────────────────────────────────────────────────

  it("db.saveTicket throws WorkspaceNotInitializedError when workspace not initialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      db.saveTicket({
        id: "iso-blocked",
        title: "blocked",
        status: "backlog",
        labels: [],
        blockedBy: [],
        comments: [],
        audit: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });

  // ─── store.ts (JSON fallback) ────────────────────────────────────────────

  it("store.saveTicket throws WorkspaceNotInitializedError when workspace not initialized", () => {
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      store.saveTicket({
        id: "iso-blocked-store",
        title: "blocked",
        status: "backlog",
        labels: [],
        comments: [],
        audit: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });

  // ─── migration.ts (loadJsonTickets/Sprints) ──────────────────────────────

  it("migration.migrateIfNeeded throws WorkspaceNotInitializedError when workspace not initialized", () => {
    // migrateIfNeeded resolves the tickets/sprints dirs. Drive it through a
    // fresh in-memory better-sqlite3 db so it actually reaches the
    // file-system resolution (and our gate).
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL,
        description TEXT, status TEXT, priority TEXT, assigneeId TEXT,
        assigneeName TEXT, assigneeProfileId TEXT, reviewPhase TEXT,
        reworkCount INTEGER, sprintId TEXT, labels TEXT, blockedBy TEXT,
        type TEXT, comments TEXT, audit TEXT, createdBy TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, closedAt TEXT,
        resultSummary TEXT);
      CREATE TABLE sprints (id TEXT PRIMARY KEY, name TEXT NOT NULL,
        teamId TEXT, daemonId TEXT, status TEXT, ticketIds TEXT,
        startedAt TEXT, endedAt TEXT, createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL);
    `);

    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      migration.migrateIfNeeded(sqlite);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotInitializedError);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });
});
