// Tests for the sprint-migration path of migrateIfNeeded().
//
// The existing migration-json.test.ts covers ticket JSON migration but leaves
// the sprints branch of migrateIfNeeded() completely untested:
//   - Sprints stored as flat JSON files in .zana/sprints/ are inserted into
//     the SQLite `sprints` table when the tickets table is empty.
//   - The legacy `hiveId` field is coalesced into `daemonId` during migration
//     (src line 133: `daemonId: sprint.daemonId || sprint.hiveId || null`).
//   - `_index.json` files and corrupt JSON files are silently skipped.
//   - An empty sprints dir (with no ticket files either) exits early.

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
      closedAt TEXT, resultSummary TEXT, parentId TEXT
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
let sprintsDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migration-sprints-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
  sprintsDir = (core as any).project.workspaceContext.getProjectPaths().sprintsDir;
  fs.mkdirSync(sprintsDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("migrateIfNeeded — sprint JSON-to-SQLite migration", () => {
  it("migrates a sprint JSON file into the sprints table", () => {
    const db = createDatabase();
    const sprint = {
      id: "S-1",
      name: "Sprint One",
      status: "active",
      teamId: "team-a",
      daemonId: "daemon-1",
      ticketIds: ["T-1", "T-2"],
      startedAt: NOW,
      endedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    fs.writeFileSync(path.join(sprintsDir, "S-1.json"), JSON.stringify(sprint));

    migrateIfNeeded(db);

    const row: any = db.prepare("SELECT * FROM sprints WHERE id = ?").get("S-1");
    expect(row).not.toBeNull();
    expect(row.name).toBe("Sprint One");
    expect(row.status).toBe("active");
    expect(row.daemonId).toBe("daemon-1");
    expect(JSON.parse(row.ticketIds)).toEqual(["T-1", "T-2"]);
  });

  it("maps legacy hiveId to daemonId when daemonId is absent", () => {
    // Exercises the `sprint.daemonId || sprint.hiveId || null` coalesce on
    // migration.ts line ~133.
    const db = createDatabase();
    const legacySprint = {
      id: "S-legacy",
      name: "Legacy Sprint",
      hiveId: "hive-42",        // old field name
      // no daemonId field
      status: "planning",
      ticketIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    fs.writeFileSync(path.join(sprintsDir, "S-legacy.json"), JSON.stringify(legacySprint));

    migrateIfNeeded(db);

    const row: any = db.prepare("SELECT daemonId FROM sprints WHERE id = ?").get("S-legacy");
    expect(row).not.toBeNull();
    expect(row.daemonId).toBe("hive-42");
  });

  it("skips _index.json and silently ignores corrupt sprint JSON", () => {
    const db = createDatabase();
    const good = {
      id: "S-good", name: "Good Sprint", status: "planning",
      ticketIds: [], createdAt: NOW, updatedAt: NOW,
    };
    fs.writeFileSync(path.join(sprintsDir, "S-good.json"), JSON.stringify(good));
    fs.writeFileSync(path.join(sprintsDir, "_index.json"), JSON.stringify({ ignored: true }));
    fs.writeFileSync(path.join(sprintsDir, "corrupt.json"), "{ bad json {{");

    migrateIfNeeded(db);

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM sprints").get();
    expect(cnt.c).toBe(1);
    const row: any = db.prepare("SELECT id FROM sprints").get();
    expect(row.id).toBe("S-good");
  });

  it("is a no-op when both tickets and sprints dirs are empty", () => {
    // loadJsonTickets() and loadJsonSprints() both return [] →
    // `if (tickets.length === 0 && sprints.length === 0) return;` fires.
    const db = createDatabase();
    migrateIfNeeded(db);
    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM sprints").get();
    expect(cnt.c).toBe(0);
  });

  it("migrates multiple sprint files in a single transaction", () => {
    const db = createDatabase();
    for (let i = 1; i <= 3; i++) {
      const sprint = {
        id: `S-multi-${i}`, name: `Sprint ${i}`, status: "planning",
        ticketIds: [], createdAt: NOW, updatedAt: NOW,
      };
      fs.writeFileSync(path.join(sprintsDir, `S-multi-${i}.json`), JSON.stringify(sprint));
    }

    migrateIfNeeded(db);

    const cnt: any = db.prepare("SELECT COUNT(*) as c FROM sprints").get();
    expect(cnt.c).toBe(3);
  });
});
