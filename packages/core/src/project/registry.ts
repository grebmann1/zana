/**
 * project-registry.js — Core CRUD module for ~/.zana/projects.json
 *
 * Manages the global registry of known projects. Provides listing, import,
 * removal, pinning, archiving, health checks, and reordering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import * as config from "@zana-ai/contracts";
import { initProjectDir, isProjectInitialized } from "./init";
import { createForWorkspace } from "@zana-ai/contracts";

// ─── Paths ────────────────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(config.ZANA_DIR, "projects.json");
const REGISTRY_TMP_PATH = path.join(config.ZANA_DIR, ".projects.json.tmp");

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Generate a unique project ID.
 */
function generateId() {
  return "proj_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Read and parse the registry file. Returns the full data object.
 * On first load, migrates from recent-workspaces.json if available.
 */
function readRegistry() {
  // Ensure ZANA_DIR exists
  if (!fs.existsSync(config.ZANA_DIR)) {
    fs.mkdirSync(config.ZANA_DIR, { recursive: true });
  }

  if (fs.existsSync(REGISTRY_PATH)) {
    try {
      const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
      const data = JSON.parse(raw);
      if (data && data.version === 1 && Array.isArray(data.projects)) {
        return data;
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  // Auto-migrate from recent-workspaces.json if it exists
  const migrated = migrateFromRecentWorkspaces();
  if (migrated) {
    return migrated;
  }

  // Return empty registry
  const empty = { version: 1, projects: [] };
  writeRegistry(empty);
  return empty;
}

/**
 * Atomically write the registry to disk.
 */
function writeRegistry(data) {
  if (!fs.existsSync(config.ZANA_DIR)) {
    fs.mkdirSync(config.ZANA_DIR, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(REGISTRY_TMP_PATH, content, "utf8");
  fs.renameSync(REGISTRY_TMP_PATH, REGISTRY_PATH);
}

/**
 * Migrate entries from recent-workspaces.json into the new projects.json format.
 * Returns the migrated registry object, or null if nothing to migrate.
 */
function migrateFromRecentWorkspaces() {
  const recentPath = config.RECENT_WORKSPACES_PATH;
  if (!fs.existsSync(recentPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(recentPath, "utf8");
    const entries = JSON.parse(raw);

    if (!Array.isArray(entries) || entries.length === 0) {
      return null;
    }

    const now = new Date().toISOString();
    const projects = [];

    for (const entry of entries) {
      const absPath = typeof entry === "string" ? entry : entry.path;
      if (!absPath) continue;

      const resolvedPath = path.resolve(absPath);

      // Dedup within migration
      if (projects.some((p) => p.path === resolvedPath)) continue;

      const name = readProjectName(resolvedPath);

      projects.push({
        id: generateId(),
        name,
        path: resolvedPath,
        addedAt: entry.addedAt || now,
        lastOpenedAt: entry.lastOpenedAt || entry.addedAt || now,
        pinned: false,
        color: null,
        tags: [],
        status: "active",
      });
    }

    const data = { version: 1, projects };
    writeRegistry(data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Read a project name from .zana/config.json, falling back to path.basename().
 */
function readProjectName(absPath) {
  const configPath = createForWorkspace(absPath).getProjectPaths().configPath;
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);
      if (cfg.name) return cfg.name;
    }
  } catch {
    // Fall through
  }
  return path.basename(absPath);
}

/**
 * Sort projects: pinned first (by lastOpenedAt desc), then non-pinned by lastOpenedAt desc.
 */
function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // Both in same group — sort by lastOpenedAt descending
    return new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime();
  });
}

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * List projects. Returns active entries by default, sorted pinned-first then by lastOpenedAt desc.
 * Pass { status: 'archived' } to list archived entries instead.
 *
 * @param {{ status?: string }} [opts]
 * @returns {object[]}
 */
export function list(opts) {
  const data = readRegistry();
  const filterStatus = (opts && opts.status) || "active";
  const filtered = data.projects.filter((p) => p.status === filterStatus);
  return sortProjects(filtered);
}

/**
 * Get a project entry by ID.
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getById(id) {
  const data = readRegistry();
  return data.projects.find((p) => p.id === id) || null;
}

/**
 * Get a project entry by absolute path (resolved for dedup).
 *
 * @param {string} absPath
 * @returns {object|null}
 */
export function getByPath(absPath) {
  const resolvedPath = path.resolve(absPath);
  const data = readRegistry();
  return data.projects.find((p) => p.path === resolvedPath) || null;
}

/**
 * Import a project into the registry. Deduplicates by resolved path.
 * Initializes .zana/ if missing. Re-activates archived projects.
 *
 * @param {string} absPath
 * @param {{ name?: string, tags?: string[], color?: string }} [opts]
 * @returns {object} The project entry
 */
export function importProject(absPath, opts) {
  const resolvedPath = path.resolve(absPath);
  const data = readRegistry();

  // Check for existing entry (dedup by path)
  const existing = data.projects.find((p) => p.path === resolvedPath);
  if (existing) {
    // Re-activate if archived
    if (existing.status === "archived") {
      existing.status = "active";
      existing.lastOpenedAt = new Date().toISOString();
      writeRegistry(data);
    }
    return existing;
  }

  // Initialize .zana/ if not present
  if (!isProjectInitialized(resolvedPath)) {
    initProjectDir(resolvedPath, { silent: true });
  }

  const name = (opts && opts.name) || readProjectName(resolvedPath);
  const now = new Date().toISOString();

  const entry = {
    id: generateId(),
    name,
    path: resolvedPath,
    addedAt: now,
    lastOpenedAt: now,
    pinned: false,
    color: (opts && opts.color) || null,
    tags: (opts && opts.tags) || [],
    status: "active",
  };

  data.projects.push(entry);
  writeRegistry(data);
  return entry;
}

/**
 * Remove a project from the registry (hard delete).
 *
 * @param {string} id
 * @returns {boolean} True if found and removed
 */
export function removeProject(id) {
  const data = readRegistry();
  const idx = data.projects.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  data.projects.splice(idx, 1);
  writeRegistry(data);
  return true;
}

/**
 * Toggle a project's pinned status.
 *
 * @param {string} id
 * @returns {object|null} Updated entry or null if not found
 */
export function togglePin(id) {
  const data = readRegistry();
  const entry = data.projects.find((p) => p.id === id);
  if (!entry) return null;
  entry.pinned = !entry.pinned;
  writeRegistry(data);
  return entry;
}

/**
 * Partially update a project entry (name, color, tags, pinned).
 *
 * @param {string} id
 * @param {{ name?: string, color?: string|null, tags?: string[], pinned?: boolean }} fields
 * @returns {object|null} Updated entry or null if not found
 */
export function updateProject(id, fields) {
  const data = readRegistry();
  const entry = data.projects.find((p) => p.id === id);
  if (!entry) return null;

  const allowedFields = ["name", "color", "tags", "pinned"];
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      entry[key] = fields[key];
    }
  }

  writeRegistry(data);
  return entry;
}

/**
 * Update a project's lastOpenedAt to the current time.
 *
 * @param {string} id
 */
export function touchProject(id) {
  const data = readRegistry();
  const entry = data.projects.find((p) => p.id === id);
  if (!entry) return;
  entry.lastOpenedAt = new Date().toISOString();
  writeRegistry(data);
}

/**
 * Archive a project (set status to 'archived').
 *
 * @param {string} id
 * @returns {object|null} Updated entry or null if not found
 */
export function archiveProject(id) {
  const data = readRegistry();
  const entry = data.projects.find((p) => p.id === id);
  if (!entry) return null;
  entry.status = "archived";
  writeRegistry(data);
  return entry;
}

/**
 * Check the health of a project: path exists, .zana/ initialized, config.json parseable.
 *
 * @param {string} id
 * @returns {{ exists: boolean, projectInitialized: boolean, configValid: boolean }}
 */
export function checkHealth(id) {
  const data = readRegistry();
  const entry = data.projects.find((p) => p.id === id);
  if (!entry) {
    return { exists: false, projectInitialized: false, configValid: false };
  }

  const exists = fs.existsSync(entry.path);
  if (!exists) {
    return { exists: false, projectInitialized: false, configValid: false };
  }

  const projectInitialized = isProjectInitialized(entry.path);

  let configValid = false;
  const configPath = createForWorkspace(entry.path).getProjectPaths().configPath;
  try {
    if (fs.existsSync(configPath)) {
      JSON.parse(fs.readFileSync(configPath, "utf8"));
      configValid = true;
    }
  } catch {
    configValid = false;
  }

  return { exists, projectInitialized, configValid };
}

/**
 * Run health checks on all active projects.
 *
 * @returns {Record<string, { exists: boolean, projectInitialized: boolean, configValid: boolean }>}
 */
export function checkAllHealth() {
  const data = readRegistry();
  const results = {};
  for (const entry of data.projects.filter((p) => p.status === "active")) {
    results[entry.id] = checkHealth(entry.id);
  }
  return results;
}

/**
 * Reorder projects by the given array of IDs. Entries not in orderedIds
 * are appended at the end in their existing order.
 *
 * @param {string[]} orderedIds
 */
export function reorder(orderedIds) {
  const data = readRegistry();
  const byId = new Map(data.projects.map((p) => [p.id, p]));

  const reordered = [];
  for (const id of orderedIds) {
    const entry = byId.get(id);
    if (entry) {
      reordered.push(entry);
      byId.delete(id);
    }
  }

  // Append remaining entries not in orderedIds
  for (const entry of byId.values()) {
    reordered.push(entry);
  }

  data.projects = reordered;
  writeRegistry(data);
}

