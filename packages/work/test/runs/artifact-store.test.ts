// Unit tests for packages/work/src/runs/artifact-store.ts
//
// Focuses on getArtifact / deleteArtifact adversarial-input handling.
// These two functions use an inline `.replace()` strip rather than the stricter
// `sanitizeArtifactId()` used by createArtifact/updateArtifact.  The critical
// invariant is that the inline strip is still safe (no path escape) even though
// it silently coerces bad IDs rather than rejecting them.
//
// createArtifact / updateArtifact path-hardening is covered by
// artifact-id-sanitization.test.ts; CAS and CRUD happy paths are covered by
// artifact-store-cas.test.ts and artifact-store-crud.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-store-${Date.now()}-${process.pid}`,
);

describe("artifact-store: getArtifact / deleteArtifact adversarial IDs", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  // ── getArtifact ─────────────────────────────────────────────────────────────

  it("getArtifact strips path-traversal chars and returns null (no file at coerced path)", () => {
    // "../../pwn" → strip "/." → "pwn"; no "pwn.json" in artifactsDir → null.
    const result = artifactStore.getArtifact("../../pwn");
    expect(result).toBeNull();
  });

  it("getArtifact with all-special chars returns null (empty sanitized = '.json' missing)", () => {
    // "!@#$" → strip all → ""; filePath becomes "<dir>/.json" which doesn't exist.
    const result = artifactStore.getArtifact("!@#$");
    expect(result).toBeNull();
  });

  it("getArtifact does NOT read files outside the artifacts directory", () => {
    // Place a decoy file at the workspace root to prove path containment.
    const decoy = path.join(TEST_WORKSPACE, "secret.json");
    fs.writeFileSync(decoy, JSON.stringify({ secret: true }));
    // Even if the ID contains ".." and "secret", the resulting coerced ID is
    // "secret" and the lookup targets <artifactsDir>/secret.json, not the root.
    const result = artifactStore.getArtifact("../secret");
    expect(result).toBeNull();
  });

  // ── deleteArtifact ──────────────────────────────────────────────────────────

  it("deleteArtifact strips path-traversal chars and returns false (no file at coerced path)", () => {
    const result = artifactStore.deleteArtifact("../../pwn");
    expect(result).toBe(false);
  });

  it("deleteArtifact with all-special chars returns false", () => {
    const result = artifactStore.deleteArtifact("!@#$");
    expect(result).toBe(false);
  });

  it("deleteArtifact removes a coerced-but-existing artifact safely", () => {
    // Seed an artifact with a simple id.  Ask to delete it using an id that
    // contains only the allowed chars once special chars are stripped.
    artifactStore.createArtifact({ id: "art-del", title: "temp" });
    // "art-del!" → strip "!" → "art-del" → targets the actual artifact.
    const result = artifactStore.deleteArtifact("art-del!");
    expect(result).toBe(true);
    expect(artifactStore.getArtifact("art-del")).toBeNull();
  });
});
