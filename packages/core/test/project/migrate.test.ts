// Unit tests for packages/core/src/project/migrate.ts
// Covers: dryRun() return-shape and side-effect contracts.
// All tests are deterministic — no real Claude, no shared global state.
// GLOBAL_ZANA_DIR is hardcoded inside the module to ~/.zana/, so tests
// assert structural contracts that hold regardless of what lives there.
//
// migrate() calls require("./init") lazily via a CJS require, which does not
// resolve in vitest's SSR/ESM mode (frozen module namespaces prevent spying on
// node:fs exports too).  migrate() tests are therefore omitted here; dryRun()
// is the primary safe-to-test surface.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { dryRun } from "../../src/project/migrate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tmpRoots: string[] = [];

function makeTmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migrate-test-"));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

// ---------------------------------------------------------------------------
// dryRun()
// ---------------------------------------------------------------------------

describe("dryRun()", () => {
  it("returns an object with 'files' array and 'globalDir' string", () => {
    const workspace = makeTmpWorkspace();
    const result = dryRun(workspace);
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("globalDir");
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.globalDir).toBe("string");
  });

  it("globalDir is always ~/.zana", () => {
    const workspace = makeTmpWorkspace();
    const { globalDir } = dryRun(workspace);
    expect(globalDir).toBe(path.join(os.homedir(), ".zana"));
  });

  it("every returned file entry has 'source' and 'target' string properties", () => {
    const workspace = makeTmpWorkspace();
    const { files } = dryRun(workspace);
    for (const entry of files) {
      expect(typeof entry.source).toBe("string");
      expect(typeof entry.target).toBe("string");
    }
  });

  it("source paths are inside ~/.zana/", () => {
    const workspace = makeTmpWorkspace();
    const { files, globalDir } = dryRun(workspace);
    for (const entry of files) {
      expect(entry.source.startsWith(globalDir + path.sep)).toBe(true);
    }
  });

  it("target paths are inside workspaceRoot/.zana/", () => {
    const workspace = makeTmpWorkspace();
    const { files } = dryRun(workspace);
    const expectedBase = path.join(workspace, ".zana") + path.sep;
    for (const entry of files) {
      expect(entry.target.startsWith(expectedBase)).toBe(true);
    }
  });

  it("does not create any files or directories in the workspace", () => {
    const workspace = makeTmpWorkspace();
    dryRun(workspace);
    // The workspace itself should be empty — dryRun is purely read-only.
    expect(fs.readdirSync(workspace)).toHaveLength(0);
  });
});

