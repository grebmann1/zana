// Tests that storeContentAddressed throws a TypeError when `bytes` is neither
// a Buffer nor a string.  The private `toBuffer` helper (artifact-store.ts,
// lines 171-175) has three branches:
//
//   1. Buffer.isBuffer(bytes)  → passthrough  (tested in artifact-store-cas)
//   2. typeof bytes === "string" → encode     (tested in artifact-store-cas)
//   3. else → throw TypeError                 ← NOT tested anywhere before this file
//
// The workspace must be initialised so the tenant-isolation gate (the
// WorkspaceNotInitializedError check that fires BEFORE toBuffer is called)
// doesn't swallow the TypeError we actually want to assert.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-invalid-bytes-${Date.now()}-${process.pid}`,
);

describe("storeContentAddressed — invalid bytes type (toBuffer TypeError branch)", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    // Pre-create .zana/ so resolveProjectDir stops here rather than walking up
    // to a parent dir that already has .zana/ (e.g. /tmp/.zana/).
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    // Also init the dist instance reached through require("@zana-ai/core").
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("throws TypeError with a descriptive message when bytes is a number", () => {
    // The TypeError message is: "storeContentAddressed: bytes must be Buffer or string"
    expect(() => artifactStore.storeContentAddressed(42 as any)).toThrow(TypeError);
    expect(() => artifactStore.storeContentAddressed(42 as any)).toThrow(
      /bytes must be Buffer or string/,
    );
  });

  it("throws TypeError when bytes is null", () => {
    expect(() => artifactStore.storeContentAddressed(null as any)).toThrow(TypeError);
    expect(() => artifactStore.storeContentAddressed(null as any)).toThrow(
      /bytes must be Buffer or string/,
    );
  });

  it("throws TypeError when bytes is undefined", () => {
    expect(() => artifactStore.storeContentAddressed(undefined as any)).toThrow(TypeError);
  });

  it("throws TypeError when bytes is a plain object", () => {
    expect(() =>
      artifactStore.storeContentAddressed({ content: "x" } as any),
    ).toThrow(TypeError);
  });

  it("does NOT throw for empty string (valid input, zero-length blob)", () => {
    // An empty string is still a valid string — toBuffer encodes it to a
    // zero-length Buffer.  Confirm the call succeeds and returns a sha256 hash.
    const result = artifactStore.storeContentAddressed("");
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.size).toBe(0);
  });

  it("does NOT throw for zero-length Buffer (valid input, zero-length blob)", () => {
    const result = artifactStore.storeContentAddressed(Buffer.alloc(0));
    // Empty string and empty Buffer share the same sha256 digest.
    const emptyStringResult = artifactStore.storeContentAddressed("");
    expect(result.hash).toBe(emptyStringResult.hash);
    expect(result.size).toBe(0);
  });
});
