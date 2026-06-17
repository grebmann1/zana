import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

function getArtifactsDir() {
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (ctx.isInitialized()) return ctx.getProjectPaths().artifactsDir;
  return path.join(core.config.ZANA_DIR, "artifacts");
}

// Tenant isolation gate for artifact WRITES (mirrors storeContentAddressed
// below, ADR 0002). The ~/.zana/artifacts fallback is shared across every
// workspace on this host — writing an artifact record there would mix one
// workspace's planning docs/specs into another's. Refuse rather than fall back.
// Reads stay tolerant (listArtifacts/getArtifact) so prior global-scope state
// remains inspectable.
function assertWorkspaceForWrite(operation) {
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (!ctx.isInitialized()) {
    const ErrCtor = ctx.WorkspaceNotInitializedError;
    throw new ErrCtor({ operation, path: path.join(core.config.ZANA_DIR, "artifacts") });
  }
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

function sanitizeArtifactId(id) {
  if (typeof id !== "string") return null;
  if (!id || id.length > 128) return null;
  if (!/^[a-zA-Z0-9\-_]+$/.test(id)) return null;
  return id;
}

export function createArtifact(artifact) {
  assertWorkspaceForWrite("createArtifact");
  ensureDir();
  const now = new Date().toISOString();
  let id;
  if (artifact.id) {
    id = sanitizeArtifactId(artifact.id);
    if (!id) throw new Error("invalid artifact id");
  } else {
    id = crypto.randomUUID();
  }

  const record = {
    id,
    title: artifact.title || "Untitled",
    type: artifact.type || "custom",
    content: artifact.content || "",
    tags: artifact.tags || [],
    createdBy: artifact.createdBy || process.env.ZANA_ID || "unknown",
    linkedTickets: artifact.linkedTickets || [],
    createdAt: now,
    updatedAt: now,
  };

  const filePath = path.join(getArtifactsDir(), `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

export function updateArtifact(id, updates) {
  assertWorkspaceForWrite("updateArtifact");
  const sanitized = sanitizeArtifactId(id);
  if (!sanitized) return null;
  const existing = getArtifact(sanitized);
  if (!existing) return null;

  if (updates.title !== undefined) existing.title = updates.title;
  if (updates.content !== undefined) existing.content = updates.content;
  if (updates.tags !== undefined) existing.tags = updates.tags;
  if (updates.linkedTickets !== undefined) existing.linkedTickets = updates.linkedTickets;
  existing.updatedAt = new Date().toISOString();

  const filePath = path.join(getArtifactsDir(), `${sanitized}.json`);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return existing;
}

export function deleteArtifact(id) {
  assertWorkspaceForWrite("deleteArtifact");
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

// ─────────────────────────────────────────────────────────────────────────────
// Content-addressed blob storage (governance audit substrate).
//
// Blobs are stored under getArtifactsDir()/blobs/<aa>/<rest>.bin where the full
// 64-hex sha256 digest is split into a 2-char shard prefix and a 62-char body.
// Hashes are always exposed in canonical form: "sha256:<64-hex>".
// ─────────────────────────────────────────────────────────────────────────────

const HASH_RE = /^sha256:([a-f0-9]{64})$/;

function getBlobsDir() {
  return path.join(getArtifactsDir(), "blobs");
}

function ensureBlobsDir() {
  fs.mkdirSync(getBlobsDir(), { recursive: true });
}

function parseHash(hash) {
  if (typeof hash !== "string") return null;
  const m = hash.match(HASH_RE);
  if (!m) return null;
  return m[1]; // 64-hex
}

function blobPathFromHex(hex) {
  // Use ONLY the validated hex — never the caller-supplied string — to derive
  // the path. Then assert the resolved path is inside the blobs dir.
  const shard = hex.slice(0, 2);
  const rest = hex.slice(2);
  const blobsDir = getBlobsDir();
  const resolvedBlobsDir = path.resolve(blobsDir);
  const filePath = path.join(blobsDir, shard, `${rest}.bin`);
  const resolvedFile = path.resolve(filePath);
  // Boundary check (defense-in-depth; hex is already constrained).
  if (
    resolvedFile !== path.join(resolvedBlobsDir, shard, `${rest}.bin`) ||
    !resolvedFile.startsWith(resolvedBlobsDir + path.sep)
  ) {
    return null;
  }
  return { dir: path.join(blobsDir, shard), filePath };
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  throw new TypeError("storeContentAddressed: bytes must be Buffer or string");
}

export function storeContentAddressed(bytes) {
  // Tenant isolation gate (FU-T2d): refuse CAS writes when the workspace is
  // not initialized. The fallback path (~/.zana/artifacts/blobs/) is shared
  // across every workspace on this host — landing a deliberation prompt
  // snapshot or rationale there would let workspace B probe workspace A's
  // blobs by guessing hashes. Reads of existing blobs stay open
  // (readContentAddressed/hasContentAddressed/listContentAddressed are
  // unchanged) so prior global-scope state can still be inspected.
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (!ctx.isInitialized()) {
    const ErrCtor = ctx.WorkspaceNotInitializedError;
    throw new ErrCtor({
      operation: "store",
      path: path.join(core.config.ZANA_DIR, "artifacts", "blobs"),
    });
  }

  const buf = toBuffer(bytes);
  const hex = crypto.createHash("sha256").update(buf).digest("hex");
  const hash = `sha256:${hex}`;
  const size = buf.length;

  ensureBlobsDir();
  const loc = blobPathFromHex(hex);
  if (!loc) {
    // Should be impossible given hex came from createHash, but fail safely.
    throw new Error("storeContentAddressed: failed to derive safe blob path");
  }
  const { dir, filePath } = loc;
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    return { hash, size, existed: true };
  }

  // Atomic write: tmp + rename. Never leave a partial file under final name.
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return { hash, size, existed: false };
}

export function readContentAddressed(hash) {
  const hex = parseHash(hash);
  if (!hex) return null;
  const loc = blobPathFromHex(hex);
  if (!loc) return null;
  let buf;
  try {
    buf = fs.readFileSync(loc.filePath);
  } catch {
    return null;
  }
  // Re-hash to detect corruption — this store IS the audit substrate.
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== hex) {
    try {
      console.warn(
        `[artifact-store] content-addressed blob corruption detected: ` +
        `requested=sha256:${hex} actual=sha256:${actual} path=${loc.filePath}`
      );
    } catch {}
    return null;
  }
  return buf;
}

export function hasContentAddressed(hash) {
  const hex = parseHash(hash);
  if (!hex) return false;
  const loc = blobPathFromHex(hex);
  if (!loc) return false;
  try {
    return fs.statSync(loc.filePath).isFile();
  } catch {
    return false;
  }
}

export function listContentAddressed() {
  const blobsDir = getBlobsDir();
  const out = [];
  let shards;
  try {
    shards = fs.readdirSync(blobsDir);
  } catch {
    return out;
  }
  for (const shard of shards) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    const shardDir = path.join(blobsDir, shard);
    let files;
    try {
      files = fs.readdirSync(shardDir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = f.match(/^([a-f0-9]{62})\.bin$/);
      if (!m) continue;
      const hex = shard + m[1];
      const filePath = path.join(shardDir, f);
      try {
        const st = fs.statSync(filePath);
        out.push({
          hash: `sha256:${hex}`,
          size: st.size,
          createdAt: st.birthtime ? st.birthtime.toISOString() : st.mtime.toISOString(),
        });
      } catch {
        // skip transient
      }
    }
  }
  return out;
}
