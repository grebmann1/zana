import * as fs from "node:fs";
import * as path from "node:path";

function getTicketsDir() {
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (ctx.isInitialized()) return ctx.getProjectPaths().ticketsDir;
  return path.join(core.config.ZANA_DIR, "tickets");
}

function getSprintsDir() {
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (ctx.isInitialized()) return ctx.getProjectPaths().sprintsDir;
  return path.join(core.config.ZANA_DIR, "sprints");
}

function loadJsonTickets() {
  const dir = getTicketsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const tickets = [];

  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;

    let ticket = null;
    if (entry.isDirectory()) {
      const ticketPath = path.join(dir, entry.name, "ticket.json");
      try { ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8")); } catch { continue; }
    } else if (entry.name.endsWith(".json")) {
      try { ticket = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")); } catch { continue; }
    }

    if (ticket) tickets.push(ticket);
  }

  return tickets;
}

function loadJsonSprints() {
  const dir = getSprintsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_index.json");
  const sprints = [];

  for (const f of files) {
    try {
      const sprint = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      sprints.push(sprint);
    } catch {
      continue;
    }
  }

  return sprints;
}

export function migrateIfNeeded(db) {
  const ticketCount = db.prepare("SELECT COUNT(*) as cnt FROM tickets").get().cnt;
  if (ticketCount > 0) return;

  const tickets = loadJsonTickets();
  const sprints = loadJsonSprints();

  if (tickets.length === 0 && sprints.length === 0) return;

  const insertTicket = db.prepare(`
    INSERT OR IGNORE INTO tickets (
      id, title, description, status, priority, assigneeId, assigneeName,
      assigneeProfileId, reviewPhase, reworkCount, sprintId, labels, blockedBy,
      type, comments, audit, createdBy, createdAt, updatedAt, closedAt, resultSummary
    ) VALUES (
      @id, @title, @description, @status, @priority, @assigneeId, @assigneeName,
      @assigneeProfileId, @reviewPhase, @reworkCount, @sprintId, @labels, @blockedBy,
      @type, @comments, @audit, @createdBy, @createdAt, @updatedAt, @closedAt, @resultSummary
    )
  `);

  const insertSprint = db.prepare(`
    INSERT OR IGNORE INTO sprints (
      id, name, teamId, daemonId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt
    ) VALUES (
      @id, @name, @teamId, @daemonId, @status, @ticketIds, @startedAt, @endedAt, @createdAt, @updatedAt
    )
  `);

  const migrate = db.transaction(() => {
    for (const ticket of tickets) {
      insertTicket.run({
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
    }

    for (const sprint of sprints) {
      insertSprint.run({
        id: sprint.id,
        name: sprint.name,
        teamId: sprint.teamId || null,
        daemonId: sprint.daemonId || sprint.hiveId || null,
        status: sprint.status || "planning",
        ticketIds: JSON.stringify(sprint.ticketIds || []),
        startedAt: sprint.startedAt || null,
        endedAt: sprint.endedAt || null,
        createdAt: sprint.createdAt,
        updatedAt: sprint.updatedAt,
      });
    }
  });

  migrate();
}

// Schema migration: rename legacy `hiveId` column on sprints to `daemonId`.
// Idempotent — safe to run on every getDb().
export function migrateSchemaIfNeeded(db) {
  let cols;
  try {
    cols = db.prepare("PRAGMA table_info(sprints)").all();
  } catch {
    return;
  }
  if (!cols || cols.length === 0) return;

  const hasLegacy = cols.some((c) => c.name === "hiveId");
  const hasNew = cols.some((c) => c.name === "daemonId");

  if (!hasLegacy) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints_new (
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

  if (hasNew) {
    // Both columns coexist (shouldn't normally happen). Coalesce.
    db.exec(`
      INSERT OR IGNORE INTO sprints_new (id, name, teamId, daemonId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt)
        SELECT id, name, teamId, COALESCE(daemonId, hiveId), status, ticketIds, startedAt, endedAt, createdAt, updatedAt FROM sprints;
    `);
  } else {
    db.exec(`
      INSERT OR IGNORE INTO sprints_new (id, name, teamId, daemonId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt)
        SELECT id, name, teamId, hiveId, status, ticketIds, startedAt, endedAt, createdAt, updatedAt FROM sprints;
    `);
  }

  db.exec(`
    DROP TABLE sprints;
    ALTER TABLE sprints_new RENAME TO sprints;
  `);
}

