import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-id-${Date.now()}-${process.pid}`
);

describe("artifact-store id sanitization (path-traversal hardening)", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    // Pre-create .zana/ so resolveProjectDir stops here instead of walking up
    // to a parent dir that already has .zana/ (e.g. /tmp/.zana/).
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  function artifactsDir() {
    return workspaceContext.getProjectPaths().artifactsDir;
  }

  it("createArtifact with path-traversal id throws and writes nothing outside artifactsDir", () => {
    const escape = path.join(TEST_WORKSPACE, "pwn.json");
    expect(() =>
      artifactStore.createArtifact({ id: "../../../../tmp/pwn", title: "evil", content: "x" })
    ).toThrow(/invalid artifact id/);
    expect(fs.existsSync(escape)).toBe(false);
    // The sanitized form ("tmppwn") would land inside the artifacts dir, but
    // because we throw on slashes/dots we never get there either.
    const sanitizedName = path.join(artifactsDir(), "tmppwn.json");
    expect(fs.existsSync(sanitizedName)).toBe(false);
  });

  it("createArtifact with absolute-path id throws", () => {
    expect(() =>
      artifactStore.createArtifact({ id: "/etc/passwd", title: "evil" })
    ).toThrow(/invalid artifact id/);
    const escape = "/etc/passwd.json";
    // Don't even try to read /etc — just confirm the call rejected.
    // We can't write to /etc as a non-root test runner anyway, but the throw
    // is the contract.
    expect(true).toBe(true);
    void escape;
  });

  it("createArtifact with all-special-chars id throws (no empty filename)", () => {
    expect(() =>
      artifactStore.createArtifact({ id: "../", title: "x" })
    ).toThrow(/invalid artifact id/);
  });

  it("createArtifact accepts safe ids (alphanumeric, hyphen, underscore)", () => {
    const rec = artifactStore.createArtifact({ id: "qa-probe_42", title: "ok" });
    expect(rec.id).toBe("qa-probe_42");
    expect(fs.existsSync(path.join(artifactsDir(), "qa-probe_42.json"))).toBe(true);
  });

  it("createArtifact with no id auto-generates a UUID", () => {
    const rec = artifactStore.createArtifact({ title: "auto" });
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("createArtifact rejects ids longer than 128 chars", () => {
    const long = "a".repeat(200);
    expect(() => artifactStore.createArtifact({ id: long, title: "x" })).toThrow(/invalid artifact id/);
  });

  it("updateArtifact with path-traversal id returns null and writes nothing outside artifactsDir", () => {
    artifactStore.createArtifact({ id: "real", title: "first", content: "v1" });
    const escape = path.join(TEST_WORKSPACE, "pwn.json");
    const result = artifactStore.updateArtifact("../../../tmp/pwn", { content: "v2" });
    expect(result).toBeNull();
    expect(fs.existsSync(escape)).toBe(false);
  });
});
