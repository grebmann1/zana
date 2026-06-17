// Edge-case tests for listContentAddressed() in artifact-store.ts.
//
// The main artifact-store-cas.test.ts covers the happy path (enumerate stored
// blobs).  These tests exercise the three defensive branches in
// listContentAddressed() that have no existing coverage:
//
//   1. Blobs dir doesn't exist → early-return [] (the try/catch around the
//      outer readdirSync).
//
//   2. Non-shard entries in the blobs dir (e.g. ".DS_Store", ".tmp" file, a
//      directory named "tmp") are silently skipped by the
//      `!/^[a-f0-9]{2}$/.test(shard)` guard.
//
//   3. Non-".bin" files inside a valid shard directory (e.g. "README.txt",
//      "partial.tmp") are skipped by the `m = f.match(/^([a-f0-9]{62})\.bin$/)` guard.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-cas-list-edge-${Date.now()}-${process.pid}`,
);

function blobsDir() {
  return path.join(workspaceContext.getProjectPaths().artifactsDir, "blobs");
}

describe("listContentAddressed — edge cases", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  // ── Branch 1: blobs dir absent ──────────────────────────────────────────

  it("returns [] when the blobs directory has never been created", () => {
    // The artifacts dir itself doesn't exist yet — no storeContentAddressed
    // has ever been called — so getBlobsDir() points at a non-existent path.
    const result = artifactStore.listContentAddressed();
    expect(result).toEqual([]);
  });

  // ── Branch 2: non-shard entries in the blobs dir ────────────────────────

  it("silently skips non-shard entries in the blobs directory", () => {
    // First store a real blob so we know at least one shard dir exists and
    // the function iterates.
    const { hash } = artifactStore.storeContentAddressed("anchor-blob");

    // Inject non-shard artifacts directly into the blobs dir.
    const bd = blobsDir();
    fs.writeFileSync(path.join(bd, ".DS_Store"), "fake-mac-metadata");
    fs.writeFileSync(path.join(bd, "not-a-shard.txt"), "random file");
    fs.mkdirSync(path.join(bd, "tmp-dir"), { recursive: true });
    // Also a 3-char dir — too long to be a shard (must be exactly 2 hex chars).
    fs.mkdirSync(path.join(bd, "abc"), { recursive: true });

    const list = artifactStore.listContentAddressed();

    // The real blob must still appear.
    const hashes = list.map((e) => e.hash);
    expect(hashes).toContain(hash);

    // Non-shard entries must NOT appear in the results.
    expect(hashes.every((h) => h.startsWith("sha256:"))).toBe(true);
    // All returned entries must have the canonical format.
    for (const entry of list) {
      expect(entry.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(typeof entry.size).toBe("number");
    }
  });

  // ── Branch 3: non-".bin" files inside a valid shard directory ───────────

  it("skips non-.bin files inside a valid shard directory", () => {
    // Store a real blob to create a proper shard dir.
    const { hash } = artifactStore.storeContentAddressed("real-content-for-shard");

    // Locate the shard dir the stored blob landed in.
    const hex = hash.slice("sha256:".length);
    const shard = hex.slice(0, 2);
    const shardDir = path.join(blobsDir(), shard);

    // Plant non-.bin files next to the real blob.
    fs.writeFileSync(path.join(shardDir, "README.txt"), "docs");
    fs.writeFileSync(path.join(shardDir, "partial.tmp"), "incomplete");
    // A file with the right length but wrong extension.
    fs.writeFileSync(path.join(shardDir, "a".repeat(62) + ".json"), "{}");

    const list = artifactStore.listContentAddressed();
    const hashes = list.map((e) => e.hash);

    // The real blob must appear exactly once.
    expect(hashes.filter((h) => h === hash)).toHaveLength(1);

    // Every returned entry must parse as a valid sha256: hash — the injected
    // non-.bin files must not produce spurious entries.
    for (const entry of list) {
      expect(entry.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});
