import * as path from "node:path";
import * as fs from "node:fs";
import * as ticketStoreFallback from "./store";
import * as migration from "./migration";
function _core() { return require("@zana-ai/core"); }
const workspaceContext: any = new Proxy({}, { get: (_t, p) => _core().project.workspaceContext[p] });

let Database: any;
try { Database = require("better-sqlite3"); } catch { Database = null; }

let _db: any = null;

function getDbPath() {
  if (workspaceContext.isInitialized()) {
    const projectDir = workspaceContext.getProjectDir();
    fs.mkdirSync(projectDir, { recursive: true });
    return path.join(projectDir, "tickets.db");
  }
  const ZANA_DIR = _core().config.ZANA_DIR;
  fs.mkdirSync(ZANA_DIR, { recursive: true });
  return path.join(ZANA_DIR, "tickets.db");
}

function getDb() {
  if (_db) return _db;

  const dbPath = getDbPath();
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_sprint ON tickets(sprintId);
    CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS sprints (
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

  migration.migrateSchemaIfNeeded(_db);
  migration.migrateIfNeeded(_db);

  return _db;
}

function rowToTicket(row) {
  if (!row) return null;
  return {
    ...row,
    labels: JSON.parse(row.labels || "[]"),
    blockedBy: JSON.parse(row.blockedBy || "[]"),
    comments: JSON.parse(row.comments || "[]"),
    audit: JSON.parse(row.audit || "[]"),
    reworkCount: row.reworkCount || 0,
  };
}

function rowToSprint(row) {
  if (!row) return null;
  return {
    ...row,
    ticketIds: JSON.parse(row.ticketIds || "[]"),
  };
}

function _listTickets(filter: any = {}) {
  const db = getDb();
  let sql = "SELECT * FROM tickets WHERE 1=1";
  const params: any[] = [];

  if (filter.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter.sprintId) {
    sql += " AND sprintId = ?";
    params.push(filter.sprintId);
  }
  if (filter.assigneeId) {
    sql += " AND assigneeId = ?";
    params.push(filter.assigneeId);
  }
  if (filter.priority) {
    sql += " AND priority = ?";
    params.push(filter.priority);
  }
  if (filter.label) {
    sql += " AND json_each.value = ?";
    sql = sql.replace("SELECT * FROM tickets WHERE 1=1", "SELECT DISTINCT tickets.* FROM tickets, json_each(tickets.labels) WHERE 1=1");
    params.push(filter.label);
  }

  sql += " ORDER BY updatedAt DESC";

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(rowToTicket);
}

function _getTicket(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  return rowToTicket(row);
}

function _saveTicket(ticket) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tickets (
      id, title, description, status, priority, assigneeId, assigneeName,
      assigneeProfileId, reviewPhase, reworkCount, sprintId, labels, blockedBy,
      type, comments, audit, createdBy, createdAt, updatedAt, closedAt, resultSummary
    ) VALUES (
      @id, @title, @description, @status, @priority, @assigneeId, @assigneeName,
      @assigneeProfileId, @reviewPhase, @reworkCount, @sprintId, @labels, @blockedBy,
      @type, @comments, @audit, @createdBy, @createdAt, @updatedAt, @closedAt, @resultSummary
    )
  `);

  stmt.run({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description || null,
    status: ticket.status || "backlog",
    priority: ticket.priority || "medium",
    assigneeId: ticket.assigneeId || null,
    assigneeName: ticket.assigneeName || null,
    assigneeProfileId: ticket.assigneeProfileId || null,
    reviewPhase: ticket.reviewPhase || null,
    reworkCount: ticket.reworkCount || 0,
    sprintId: ticket.sprintId || null,
    labels: JSON.stringify(ticket.labels || []),
    blockedBy: JSON.stringify(ticket.blockedBy || []),
    type: ticket.type || null,
    comments: JSON.stringify(ticket.comments || []),
    audit: JSON.stringify(ticket.audit || []),
    createdBy: ticket.createdBy || null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt || null,
    resultSummary: ticket.resultSummary || null,
  });

  return ticket;
}

function _deleteTicket(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM tickets WHERE id = ?").run(id);
  return result.changes > 0;
}

function _listSprints(filter: any = {}) {
  const db = getDb();
  let sql = "SELECT * FROM sprints WHERE 1=1";
  const params: any[] = [];

  if (filter.teamId) {
    sql += " AND teamId = ?";
    params.push(filter.teamId);
  }
  if (filter.daemonId) {
    sql += " AND daemonId = ?";
    params.push(filter.daemonId);
  }
  if (filter.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }

  sql += " ORDER BY updatedAt DESC";

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(rowToSprint);
}

function _getSprint(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sprints WHERE id = ?").get(id);
  return rowToSprint(row);
}

function _saveSprint(sprint) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sprints (
      id, name, teamId, daemonId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt
    ) VALUES (
      @id, @name, @teamId, @daemonId, @status, @ticketIds, @startedAt, @endedAt, @createdAt, @updatedAt
    )
  `);

  stmt.run({
    id: sprint.id,
    name: sprint.name,
    teamId: sprint.teamId || null,
    daemonId: sprint.daemonId || null,
    status: sprint.status || "planning",
    ticketIds: JSON.stringify(sprint.ticketIds || []),
    startedAt: sprint.startedAt || null,
    endedAt: sprint.endedAt || null,
    createdAt: sprint.createdAt,
    updatedAt: sprint.updatedAt,
  });

  return sprint;
}

function _deleteSprint(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM sprints WHERE id = ?").run(id);
  return result.changes > 0;
}

function _rebuildIndex() {
}

// If sqlite is unavailable, delegate to JSON-based fallback store.
const fallback: any = ticketStoreFallback;

export const listTickets = Database ? _listTickets : fallback.listTickets;
export const getTicket = Database ? _getTicket : fallback.getTicket;
export const saveTicket = Database ? _saveTicket : fallback.saveTicket;
export const deleteTicket = Database ? _deleteTicket : fallback.deleteTicket;
export const listSprints = Database ? _listSprints : fallback.listSprints;
export const getSprint = Database ? _getSprint : fallback.getSprint;
export const saveSprint = Database ? _saveSprint : fallback.saveSprint;
export const deleteSprint = Database ? _deleteSprint : fallback.deleteSprint;
export const rebuildIndex = Database ? _rebuildIndex : (fallback.rebuildIndex || _rebuildIndex);
