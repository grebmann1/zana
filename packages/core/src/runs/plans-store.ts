/**
 * plans-store.js — Manages .zana/plans/ directory.
 *
 * Plans are Markdown documents with YAML frontmatter that capture orchestrator
 * reasoning, decision logs, and implementation plans. They live in .zana/plans/
 * and are committed to git (reviewable in PRs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Path resolution ─────────────────────────────────────────────────────────

function getPlansDir() {
  const ctx = require("../project/workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().plansDir;
  const { ZANA_DIR } = require("../config");
  return path.join(ZANA_DIR, "plans");
}

function ensureDir() {
  fs.mkdirSync(getPlansDir(), { recursive: true });
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from Markdown content.
 * Handles scalar values, arrays (both inline and multi-line dash syntax).
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {}, content: raw };

  const frontmatterStr = match[1];
  const content = raw.slice(match[0].length).replace(/^\r?\n/, "");
  const meta = {};

  const lines = frontmatterStr.split(/\r?\n/);
  let currentKey = null;
  let currentArray = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Array continuation: "  - value"
    if (/^\s+-\s+/.test(line) && currentKey) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      if (!currentArray) {
        currentArray = [];
        meta[currentKey] = currentArray;
      }
      currentArray.push(val);
      continue;
    }

    // Key: value line
    const kvMatch = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      // Inline array: [a, b, c]
      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1);
        currentArray = inner
          ? inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          : [];
        meta[currentKey] = currentArray;
      } else if (value === "") {
        // Could be start of a multi-line array
        currentArray = null;
      } else {
        // Scalar value — strip surrounding quotes
        meta[currentKey] = value.replace(/^['"]|['"]$/g, "");
        currentArray = null;
      }
    }
  }

  return { meta, content };
}

/**
 * Serialize a metadata object into YAML frontmatter string (without --- delimiters).
 */
function serializeFrontmatter(meta) {
  const lines = [];

  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      // Quote titles that may contain special chars
      if (key === "title" && value) {
        lines.push(`${key}: "${value}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new plan. Returns the full plan object.
 */
export function createPlan({ title, content, createdBy, linkedTickets, tags }) {
  ensureDir();

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const meta = {
    id,
    title: title || "Untitled Plan",
    status: "draft",
    createdBy: createdBy || process.env.ZANA_ID || "orchestrator",
    createdAt: now,
    updatedAt: now,
    linkedTickets: linkedTickets || [],
    tags: tags || [],
  };

  const body = content || "";
  const fileContent = `---\n${serializeFrontmatter(meta)}\n---\n\n${body}\n`;

  const filePath = path.join(getPlansDir(), `${id}.md`);
  fs.writeFileSync(filePath, fileContent, "utf8");

  return { ...meta, content: body };
}

/**
 * List plans (frontmatter only, no content).
 * Optional filter: { status, tag, createdBy }
 */
export function listPlans(filter = {}) {
  ensureDir();

  try {
    const files = fs.readdirSync(getPlansDir()).filter((f) => f.endsWith(".md"));
    let plans = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(getPlansDir(), file), "utf8");
        const { meta } = parseFrontmatter(raw);
        if (meta.id) plans.push(meta);
      } catch {
        // Skip unreadable files
      }
    }

    // Apply filters
    if (filter.status) {
      plans = plans.filter((p) => p.status === filter.status);
    }
    if (filter.tag) {
      plans = plans.filter(
        (p) => Array.isArray(p.tags) && p.tags.includes(filter.tag)
      );
    }
    if (filter.createdBy) {
      plans = plans.filter((p) => p.createdBy === filter.createdBy);
    }

    // Sort by updatedAt descending
    plans.sort((a, b) => {
      const dateA = a.updatedAt || a.createdAt || "";
      const dateB = b.updatedAt || b.createdAt || "";
      return dateB.localeCompare(dateA);
    });

    return plans;
  } catch {
    return [];
  }
}

/**
 * Get a single plan by ID (full plan with content).
 */
export function getPlan(id) {
  if (!id) return null;
  ensureDir();

  const sanitized = id.replace(/[^a-zA-Z0-9\-]/g, "");
  const filePath = path.join(getPlansDir(), `${sanitized}.md`);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const { meta, content } = parseFrontmatter(raw);
    return { ...meta, content };
  } catch {
    return null;
  }
}

/**
 * Update an existing plan's frontmatter and/or content.
 * Returns the updated plan or null if not found.
 */
export function updatePlan(id, updates) {
  const existing = getPlan(id);
  if (!existing) return null;

  const { content: existingContent, ...existingMeta } = existing;

  // Apply frontmatter updates
  if (updates.title !== undefined) existingMeta.title = updates.title;
  if (updates.status !== undefined) existingMeta.status = updates.status;
  if (updates.linkedTickets !== undefined) existingMeta.linkedTickets = updates.linkedTickets;
  if (updates.tags !== undefined) existingMeta.tags = updates.tags;
  existingMeta.updatedAt = new Date().toISOString();

  // Apply content update
  const newContent = updates.content !== undefined ? updates.content : existingContent;

  const fileContent = `---\n${serializeFrontmatter(existingMeta)}\n---\n\n${newContent}\n`;

  const sanitized = id.replace(/[^a-zA-Z0-9\-]/g, "");
  const filePath = path.join(getPlansDir(), `${sanitized}.md`);
  fs.writeFileSync(filePath, fileContent, "utf8");

  return { ...existingMeta, content: newContent };
}

/**
 * Delete a plan by ID. Returns true on success, false if not found.
 */
export function deletePlan(id) {
  if (!id) return false;
  const sanitized = id.replace(/[^a-zA-Z0-9\-]/g, "");
  const filePath = path.join(getPlansDir(), `${sanitized}.md`);

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

