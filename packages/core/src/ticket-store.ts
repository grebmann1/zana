import * as fs from "node:fs";
import * as path from "node:path";

// ─── Path resolution ─────────────────────────────────────────────────────────

function getTicketsDir() {
  const ctx = require("./workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().ticketsDir;
  // Fallback to global (backwards compat during migration)
  const { HIVE_DIR } = require("./config");
  return path.join(HIVE_DIR, "tickets");
}

function getSprintsDir() {
  const ctx = require("./workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().sprintsDir;
  // Fallback to global (backwards compat during migration)
  const { HIVE_DIR } = require("./config");
  return path.join(HIVE_DIR, "sprints");
}

// ─── Dir helpers ─────────────────────────────────────────────────────────────

function ensureTicketsDir() {
  fs.mkdirSync(getTicketsDir(), { recursive: true });
}

function ensureSprintsDir() {
  fs.mkdirSync(getSprintsDir(), { recursive: true });
}

// ─── Format detection ───────────────────────────────────────────────────────

function isTicketDir(id) {
  const ticketsDir = getTicketsDir();
  const dirPath = path.join(ticketsDir, id);
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

// ─── Index generation ────────────────────────────────────────────────────────

function regenerateTicketsIndex() {
  const dir = getTicketsDir();
  fs.mkdirSync(dir, { recursive: true });

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const index = [];

  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;

    let ticket = null;
    if (entry.isDirectory()) {
      // New format: read ticket.json inside directory
      const ticketPath = path.join(dir, entry.name, "ticket.json");
      try { ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8")); } catch { continue; }
    } else if (entry.name.endsWith(".json")) {
      // Old format: flat file
      try { ticket = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")); } catch { continue; }
    }

    if (ticket) {
      index.push({
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        assigneeId: ticket.assigneeId,
        updatedAt: ticket.updatedAt,
      });
    }
  }

  // Sort newest first for fast listing
  index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
}

function regenerateSprintsIndex() {
  const dir = getSprintsDir();
  fs.mkdirSync(dir, { recursive: true });

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_index.json");
  const index = [];

  for (const f of files) {
    try {
      const sprint = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      index.push({
        id: sprint.id,
        title: sprint.title,
        status: sprint.status,
        priority: sprint.priority,
        assigneeId: sprint.assigneeId,
        updatedAt: sprint.updatedAt,
      });
    } catch {
      // skip malformed
    }
  }

  // Sort newest first for fast listing
  index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
}

/**
 * Rebuild both ticket and sprint indexes from disk.
 * Useful for recovery or after bulk file operations.
 */
export function rebuildIndex() {
  regenerateTicketsIndex();
  regenerateSprintsIndex();
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export function listTickets(filter = {}) {
  ensureTicketsDir();
  const dir = getTicketsDir();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let tickets = [];

  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;

    let ticket = null;
    if (entry.isDirectory()) {
      // New format: read ticket.json inside directory
      const ticketPath = path.join(dir, entry.name, "ticket.json");
      try { ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8")); } catch { continue; }
    } else if (entry.name.endsWith(".json")) {
      // Old format: flat file
      try { ticket = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")); } catch { continue; }
    }

    if (ticket) tickets.push(ticket);
  }

  if (filter.status) tickets = tickets.filter((t) => t.status === filter.status);
  if (filter.sprintId) tickets = tickets.filter((t) => t.sprintId === filter.sprintId);
  if (filter.assigneeId) tickets = tickets.filter((t) => t.assigneeId === filter.assigneeId);
  if (filter.label) tickets = tickets.filter((t) => t.labels && t.labels.includes(filter.label));
  if (filter.priority) tickets = tickets.filter((t) => t.priority === filter.priority);

  return tickets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getTicket(id) {
  const ticketsDir = getTicketsDir();

  // Try directory format first (new)
  const dirPath = path.join(ticketsDir, id);
  const dirTicketPath = path.join(dirPath, "ticket.json");
  if (fs.existsSync(dirTicketPath)) {
    try { return JSON.parse(fs.readFileSync(dirTicketPath, "utf8")); } catch { return null; }
  }

  // Fall back to flat format (old)
  const flatPath = path.join(ticketsDir, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(flatPath, "utf8")); } catch { return null; }
}

export function saveTicket(ticket) {
  ensureTicketsDir();
  const ticketsDir = getTicketsDir();
  const ticketDir = path.join(ticketsDir, ticket.id);

  // Always save as directory format
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, "ticket.json"), JSON.stringify(ticket, null, 2) + "\n", "utf8");

  // Remove old flat file if it exists (migration)
  const flatPath = path.join(ticketsDir, `${ticket.id}.json`);
  try { fs.unlinkSync(flatPath); } catch {}

  regenerateTicketsIndex();
  return ticket;
}

export function deleteTicket(id) {
  const ticketsDir = getTicketsDir();

  // Try directory first
  const dirPath = path.join(ticketsDir, id);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    regenerateTicketsIndex();
    return true;
  }

  // Try flat file
  try {
    fs.unlinkSync(path.join(ticketsDir, `${id}.json`));
    regenerateTicketsIndex();
    return true;
  } catch {
    return false;
  }
}

// ─── Sprints ─────────────────────────────────────────────────────────────────

export function listSprints(filter = {}) {
  ensureSprintsDir();
  const dir = getSprintsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_index.json");
  let sprints = [];

  for (const f of files) {
    try {
      const sprint = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      sprints.push(sprint);
    } catch {
      // skip malformed
    }
  }

  if (filter.teamId) sprints = sprints.filter((s) => s.teamId === filter.teamId);
  if (filter.hiveId) sprints = sprints.filter((s) => s.hiveId === filter.hiveId);
  if (filter.status) sprints = sprints.filter((s) => s.status === filter.status);

  return sprints.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getSprint(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(getSprintsDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function saveSprint(sprint) {
  ensureSprintsDir();
  fs.writeFileSync(
    path.join(getSprintsDir(), `${sprint.id}.json`),
    JSON.stringify(sprint, null, 2) + "\n",
    "utf8"
  );
  regenerateSprintsIndex();
  return sprint;
}

export function deleteSprint(id) {
  try {
    fs.unlinkSync(path.join(getSprintsDir(), `${id}.json`));
    regenerateSprintsIndex();
    return true;
  } catch {
    return false;
  }
}

