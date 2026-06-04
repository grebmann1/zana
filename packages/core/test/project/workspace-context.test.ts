// Unit tests for packages/core/src/project/workspace-context.ts
// Covers: init, getWorkspaceRoot, getProjectDir, getProjectPaths, isInitialized,
//         WorkspaceNotInitializedError, resolveProjectDir, createForWorkspace.
// All fs operations use real tmpdir — no mocks needed because the module
// exposes _resetForTesting() and createForWorkspace() for isolation.
// No network, no real Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  init,
  getWorkspaceRoot,
  getProjectDir,
  getProjectPaths,
  isInitialized,
  resolveProjectDir,
  createForWorkspace,
  WorkspaceNotInitializedError,
  _resetForTesting,
} from "../../src/project/workspace-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zana-wsc-test-"));
  tmpRoots.push(d);
  return d;
}

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  for (const d of tmpRoots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// WorkspaceNotInitializedError
// ---------------------------------------------------------------------------
describe("WorkspaceNotInitializedError", () => {
  it("carries the expected name and code", () => {
    const err = new WorkspaceNotInitializedError({ operation: "write" });
    expect(err.name).toBe("WorkspaceNotInitializedError");
    expect(err.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(err).toBeInstanceOf(Error);
  });

  it("includes operation, path, and requestedKind in the message", () => {
    const err = new WorkspaceNotInitializedError({
      operation: "write",
      path: "/some/path",
      requestedKind: "deliberation",
    });
    expect(err.message).toContain("write");
    expect(err.message).toContain("/some/path");
    expect(err.message).toContain("deliberation");
    expect(err.requestedKind).toBe("deliberation");
  });

  it("defaults operation to 'write' when not provided", () => {
    const err = new WorkspaceNotInitializedError({});
    expect(err.operation).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// Before init — everything throws
// ---------------------------------------------------------------------------
describe("before init()", () => {
  it("isInitialized() returns false", () => {
    expect(isInitialized()).toBe(false);
  });

  it("getWorkspaceRoot() throws", () => {
    expect(() => getWorkspaceRoot()).toThrow(/not initialized/i);
  });

  it("getProjectDir() throws", () => {
    expect(() => getProjectDir()).toThrow(/not initialized/i);
  });

  it("getProjectPaths() throws (delegates to getProjectDir)", () => {
    expect(() => getProjectPaths()).toThrow(/not initialized/i);
  });
});

// ---------------------------------------------------------------------------
// init() validation
// ---------------------------------------------------------------------------
describe("init() validation", () => {
  it("throws when workspaceRoot is null", () => {
    expect(() => init(null)).toThrow(/workspaceRoot is required/i);
  });

  it("throws when workspaceRoot is empty string", () => {
    expect(() => init("")).toThrow(/workspaceRoot is required/i);
  });
});

// ---------------------------------------------------------------------------
// After init — happy path
// ---------------------------------------------------------------------------
describe("after init()", () => {
  it("isInitialized() returns true", () => {
    const dir = makeTmpDir();
    init(dir);
    expect(isInitialized()).toBe(true);
  });

  it("getWorkspaceRoot() returns the resolved absolute path", () => {
    const dir = makeTmpDir();
    init(dir);
    expect(getWorkspaceRoot()).toBe(path.resolve(dir));
  });

  it("getProjectDir() returns a path ending with .zana", () => {
    const dir = makeTmpDir();
    init(dir);
    expect(getProjectDir()).toMatch(/\.zana$/);
  });

  it("getProjectPaths() returns all required keys", () => {
    const dir = makeTmpDir();
    init(dir);
    const paths = getProjectPaths();
    const requiredKeys = [
      "projectDir", "ticketsDir", "sprintsDir", "artifactsDir",
      "plansDir", "auditDir", "sessionsDir", "runsDir",
      "eventsDir", "schedulerDir", "checkpointsDir", "tmpDir", "configPath",
    ];
    for (const key of requiredKeys) {
      expect(paths).toHaveProperty(key);
      expect(typeof (paths as any)[key]).toBe("string");
    }
  });

  it("getProjectPaths() paths are all under projectDir", () => {
    const dir = makeTmpDir();
    init(dir);
    const paths = getProjectPaths();
    for (const [key, val] of Object.entries(paths)) {
      if (key !== "projectDir") {
        expect((val as string).startsWith(paths.projectDir)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectDir — filesystem walk
// ---------------------------------------------------------------------------
describe("resolveProjectDir", () => {
  it("finds an existing .zana directory in the given dir", () => {
    const dir = makeTmpDir();
    const zanaDir = path.join(dir, ".zana");
    fs.mkdirSync(zanaDir);
    expect(resolveProjectDir(dir)).toBe(zanaDir);
  });

  it("walks UP to find .zana in a parent directory", () => {
    const dir = makeTmpDir();
    const zanaDir = path.join(dir, ".zana");
    fs.mkdirSync(zanaDir);
    const nested = path.join(dir, "sub", "deep");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveProjectDir(nested)).toBe(zanaDir);
  });

  it("stops at a .git boundary and falls back to startPath/.zana", () => {
    const dir = makeTmpDir();
    // .git marks the project root — no .zana present above
    fs.mkdirSync(path.join(dir, ".git"));
    const result = resolveProjectDir(dir);
    expect(result).toBe(path.join(dir, ".zana"));
  });

  it("falls back to startPath/.zana when nothing is found", () => {
    const dir = makeTmpDir();
    const result = resolveProjectDir(dir);
    // Either it hits a .git or root — in either case the fallback is startPath/.zana
    expect(path.basename(result)).toBe(".zana");
  });
});

// ---------------------------------------------------------------------------
// createForWorkspace — isolated factory, does NOT mutate singleton
// ---------------------------------------------------------------------------
describe("createForWorkspace()", () => {
  it("returns getWorkspaceRoot() pointing at the given dir", () => {
    const dir = makeTmpDir();
    const ctx = createForWorkspace(dir);
    expect(ctx.getWorkspaceRoot()).toBe(path.resolve(dir));
  });

  it("does NOT affect the global singleton", () => {
    const dir = makeTmpDir();
    createForWorkspace(dir);
    expect(isInitialized()).toBe(false);
  });

  it("getProjectPaths() includes all required keys", () => {
    const dir = makeTmpDir();
    const ctx = createForWorkspace(dir);
    const paths = ctx.getProjectPaths();
    expect(paths).toHaveProperty("ticketsDir");
    expect(paths).toHaveProperty("checkpointsDir");
    expect(paths).toHaveProperty("artifactsDir");
  });

  it("getProjectPaths() paths derived from same projectDir", () => {
    const dir = makeTmpDir();
    const ctx = createForWorkspace(dir);
    const paths = ctx.getProjectPaths();
    expect(paths.ticketsDir.startsWith(paths.projectDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant regression — two workspace roots resolve to two distinct
// configPath values. Guards against the "join workspaceRoot + .zana/config.json"
// shortcut that bypasses workspace-context resolution (CLAUDE.md invariant:
// project-local paths MUST go through getProjectPaths()).
// ---------------------------------------------------------------------------
describe("multi-tenant configPath isolation", () => {
  it("two workspace roots produce two distinct configPath values via createForWorkspace", () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();

    const ctxA = createForWorkspace(dirA);
    const ctxB = createForWorkspace(dirB);

    const cfgA = ctxA.getProjectPaths().configPath;
    const cfgB = ctxB.getProjectPaths().configPath;

    expect(cfgA).not.toBe(cfgB);
    expect(cfgA.startsWith(path.resolve(dirA))).toBe(true);
    expect(cfgB.startsWith(path.resolve(dirB))).toBe(true);
    expect(path.basename(cfgA)).toBe("config.json");
    expect(path.basename(cfgB)).toBe("config.json");
    // configPath lives under the project's .zana dir
    expect(cfgA).toBe(path.join(ctxA.getProjectDir(), "config.json"));
    expect(cfgB).toBe(path.join(ctxB.getProjectDir(), "config.json"));
  });

  it("singleton getProjectPaths().configPath is scoped to the init()'d workspace", () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();

    init(dirA);
    const cfgA = getProjectPaths().configPath;
    expect(cfgA.startsWith(path.resolve(dirA))).toBe(true);

    _resetForTesting();
    init(dirB);
    const cfgB = getProjectPaths().configPath;
    expect(cfgB.startsWith(path.resolve(dirB))).toBe(true);

    expect(cfgA).not.toBe(cfgB);
  });
});
