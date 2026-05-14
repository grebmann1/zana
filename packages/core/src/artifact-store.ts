import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

function getArtifactsDir() {
  const ctx = require("./workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().artifactsDir;
  const { HIVE_DIR } = require("./config");
  return path.join(HIVE_DIR, "artifacts");
}

function ensureDir() {
  fs.mkdirSync(getArtifactsDir(), { recursive: true });
}

export function listArtifacts(filter = {}) {
  ensureDir();
  const artifactsDir = getArtifactsDir();
  try {
    const files = fs.readdirSync(artifactsDir).filter((f) => f.endsWith(".json"));
    let artifacts = files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(artifactsDir, f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (filter.type) {
      artifacts = artifacts.filter((a) => a.type === filter.type);
    }
    if (filter.tag) {
      artifacts = artifacts.filter((a) => a.tags && a.tags.includes(filter.tag));
    }

    return artifacts.map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type,
      tags: a.tags || [],
      createdBy: a.createdBy,
      linkedTickets: a.linkedTickets || [],
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  } catch {
    return [];
  }
}

export function getArtifact(id) {
  if (!id) return null;
  ensureDir();
  const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  const filePath = path.join(getArtifactsDir(), `${sanitized}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function createArtifact(artifact) {
  ensureDir();
  const now = new Date().toISOString();
  const id = artifact.id || crypto.randomUUID();

  const record = {
    id,
    title: artifact.title || "Untitled",
    type: artifact.type || "custom",
    content: artifact.content || "",
    tags: artifact.tags || [],
    createdBy: artifact.createdBy || process.env.HIVE_ID || "unknown",
    linkedTickets: artifact.linkedTickets || [],
    createdAt: now,
    updatedAt: now,
  };

  const filePath = path.join(getArtifactsDir(), `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

export function updateArtifact(id, updates) {
  const existing = getArtifact(id);
  if (!existing) return null;

  if (updates.title !== undefined) existing.title = updates.title;
  if (updates.content !== undefined) existing.content = updates.content;
  if (updates.tags !== undefined) existing.tags = updates.tags;
  if (updates.linkedTickets !== undefined) existing.linkedTickets = updates.linkedTickets;
  existing.updatedAt = new Date().toISOString();

  const filePath = path.join(getArtifactsDir(), `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return existing;
}

export function deleteArtifact(id) {
  if (!id) return false;
  const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  const filePath = path.join(getArtifactsDir(), `${sanitized}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

