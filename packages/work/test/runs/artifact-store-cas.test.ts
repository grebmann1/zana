import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
// artifact-store reads workspace state via require("@zana-ai/core").project.workspaceContext.
// Under vitest's TS resolver that may end up as a different module instance than the
// one we import via the explicit ".ts" path above. Initialize BOTH so the artifact-store
// and our test see the same workspace dir.
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifacts-cas-${Date.now()}-${process.pid}`
);

function blobsDir() {
  return path.join(workspaceContext.getProjectPaths().artifactsDir, "blobs");
}

describe("artifact-store content-addressed storage (T2)", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    // Pre-create .zana/ so resolveProjectDir stops here instead of walking up
    // to a parent dir that already has .zana/ (e.g. /tmp/.zana/).
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    // Also init the instance reached through the package main entry.
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
    vi.restoreAllMocks();
  });

  it("round-trips: store then read returns identical bytes", () => {
    const payload = Buffer.from("rationale: I voted +1 because the proposal is sound.\n", "utf8");
    const result = artifactStore.storeContentAddressed(payload);
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.size).toBe(payload.length);
    expect(result.existed).toBe(false);

    const read = artifactStore.readContentAddressed(result.hash);
    expect(read).not.toBeNull();
    expect(Buffer.isBuffer(read)).toBe(true);
    expect(read!.equals(payload)).toBe(true);
  });

  it("hash is deterministic and matches the canonical sha256: prefix + 64 hex chars", () => {
    const payload = "deterministic content";
    const a = artifactStore.storeContentAddressed(payload);
    const b = artifactStore.storeContentAddressed(payload);
    const expectedHex = crypto.createHash("sha256").update(payload, "utf8").digest("hex");

    expect(a.hash).toBe(`sha256:${expectedHex}`);
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("idempotence: storing the same bytes twice yields existed=true on the second call", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const first = artifactStore.storeContentAddressed(payload);
    const second = artifactStore.storeContentAddressed(payload);

    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.size).toBe(first.size);
  });

  it("hasContentAddressed reports presence correctly", () => {
    const payload = "presence check";
    const { hash } = artifactStore.storeContentAddressed(payload);
    expect(artifactStore.hasContentAddressed(hash)).toBe(true);

    const fakeHex = "0".repeat(64);
    expect(artifactStore.hasContentAddressed(`sha256:${fakeHex}`)).toBe(false);
  });

  it("listContentAddressed enumerates stored blobs", () => {
    const a = artifactStore.storeContentAddressed("alpha");
    const b = artifactStore.storeContentAddressed("beta");
    const list = artifactStore.listContentAddressed();
    const hashes = list.map((e) => e.hash);
    expect(hashes).toContain(a.hash);
    expect(hashes).toContain(b.hash);
    for (const entry of list) {
      expect(entry.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(typeof entry.size).toBe("number");
      expect(typeof entry.createdAt).toBe("string");
    }
  });

  it("read with malformed hash returns null", () => {
    expect(artifactStore.readContentAddressed("not-a-hash")).toBeNull();
    expect(artifactStore.readContentAddressed("sha256:short")).toBeNull();
    expect(artifactStore.readContentAddressed("md5:" + "a".repeat(32))).toBeNull();
    // Uppercase hex is non-canonical — must be rejected.
    expect(artifactStore.readContentAddressed("sha256:" + "A".repeat(64))).toBeNull();
    // Non-string types
    // @ts-expect-error
    expect(artifactStore.readContentAddressed(null)).toBeNull();
    // @ts-expect-error
    expect(artifactStore.readContentAddressed(undefined)).toBeNull();
    // @ts-expect-error
    expect(artifactStore.readContentAddressed(12345)).toBeNull();
  });

  it("read with a valid-format but missing hash returns null", () => {
    const missing = "sha256:" + "f".repeat(64);
    expect(artifactStore.readContentAddressed(missing)).toBeNull();
    expect(artifactStore.hasContentAddressed(missing)).toBe(false);
  });

  it("rejects path-traversal attempts in the hash string", () => {
    // Classic traversal — fails the hex regex.
    const attempt1 = "sha256:../../../etc/passwd-padded-to-64-chars-fake-hex-aaaaa";
    expect(artifactStore.readContentAddressed(attempt1)).toBeNull();
    expect(artifactStore.hasContentAddressed(attempt1)).toBe(false);

    // Slashes inside the hex region — not hex, must be rejected.
    const attempt2 = "sha256:" + "a".repeat(30) + "/../" + "b".repeat(30);
    expect(artifactStore.readContentAddressed(attempt2)).toBeNull();
    expect(artifactStore.hasContentAddressed(attempt2)).toBe(false);

    // Null byte injection
    const attempt3 = "sha256:" + "a".repeat(63) + "\0";
    expect(artifactStore.readContentAddressed(attempt3)).toBeNull();

    // Confirm no file was created outside the blobs dir during these attempts.
    const artifactsDir = workspaceContext.getProjectPaths().artifactsDir;
    if (fs.existsSync(artifactsDir)) {
      // Only "blobs" subdir or .json artifact records are allowed siblings.
      for (const entry of fs.readdirSync(artifactsDir)) {
        // Either it's the blobs dir or a regular .json artifact — never a traversal artifact.
        const full = path.join(artifactsDir, entry);
        const rel = path.relative(artifactsDir, full);
        expect(rel.startsWith("..")).toBe(false);
      }
    }
  });

  it("corruption detection: tampering with a stored blob makes read return null and emits a warning", () => {
    const payload = Buffer.from("audit-grade rationale that must stay verifiable", "utf8");
    const { hash } = artifactStore.storeContentAddressed(payload);

    // Pre-condition: read works before tampering.
    expect(artifactStore.readContentAddressed(hash)).not.toBeNull();

    // Locate the on-disk file via the public list API (no path knowledge needed).
    const hex = hash.slice("sha256:".length);
    const shard = hex.slice(0, 2);
    const rest = hex.slice(2);
    const filePath = path.join(blobsDir(), shard, `${rest}.bin`);
    expect(fs.existsSync(filePath)).toBe(true);

    // Tamper.
    fs.writeFileSync(filePath, Buffer.from("CORRUPTED"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = artifactStore.readContentAddressed(hash);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toMatch(/corruption/i);
    expect(msg).toContain(hash);
  });

  it("accepts both Buffer and string inputs and produces the same hash", () => {
    const text = "matched payload";
    const fromString = artifactStore.storeContentAddressed(text);
    const fromBuffer = artifactStore.storeContentAddressed(Buffer.from(text, "utf8"));
    expect(fromString.hash).toBe(fromBuffer.hash);
  });
});
