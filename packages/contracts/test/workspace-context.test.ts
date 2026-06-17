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
} from "../src/workspace-context.ts";

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

  // The match guard (workspace-context.ts line 58) is
  // `fs.existsSync(candidateZana) && fs.statSync(candidateZana).isDirectory()`.
  // A `.zana` that is a regular FILE (not a directory) must therefore NOT be
  // treated as a project state dir — the walk must skip it and continue
  // upward, ultimately falling back to startPath/.zana. The existing happy
  // paths only ever create a `.zana` directory, so the isDirectory() half of
  // the guard is currently unpinned: drop it and a stray `.zana` file would be
  // silently adopted as the tenant state dir.
  it("ignores a .zana that is a regular file (not a directory)", () => {
    const dir = makeTmpDir();
    // .git marks the project boundary so the walk can't escape into the shared
    // tmp parent (which may hold a stray .zana) before falling back.
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".zana"), "not a directory");
    // No real .zana directory anywhere → falls back to startPath/.zana.
    const result = resolveProjectDir(dir);
    expect(result).toBe(path.join(dir, ".zana"));
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

  // Tenant-isolation invariant: the .git project boundary (workspace-context.ts
  // lines 59-62) must stop the upward walk BEFORE it can reach a .zana living in
  // an ancestor directory above the project root. Without this, a nested project
  // checked out under another workspace would silently resolve to the parent's
  // .zana and share its tenant state. The existing walk-up test has no .git
  // boundary and the .git test has no ancestor .zana, so this interaction is
  // currently unpinned.
  it("does NOT escape past a .git boundary to a .zana in an ancestor dir", () => {
    const ancestor = makeTmpDir();
    const ancestorZana = path.join(ancestor, ".zana");
    fs.mkdirSync(ancestorZana); // an ancestor workspace's state dir
    const projectRoot = path.join(ancestor, "project");
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".git")); // marks the project boundary
    const nested = path.join(projectRoot, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    const result = resolveProjectDir(nested);

    expect(result).not.toBe(ancestorZana);
    expect(result).toBe(path.join(nested, ".zana"));
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

  // The factory's isInitialized() (workspace-context.ts line 163) reports
  // fs.existsSync(projectDir) — distinct from the singleton's
  // `_workspaceRoot !== null` semantics. The factory therefore reports an
  // un-bootstrapped workspace as NOT initialized even after createForWorkspace()
  // returns, and flips to true only once the .zana dir physically exists. This
  // fs-existence behavior is exercised by no existing test, so per-window
  // contexts could silently report the wrong readiness on a bug. Planting .git
  // pins resolveProjectDir to the tmp dir so the result is deterministic
  // regardless of any .zana that may exist above /tmp.
  it("isInitialized() reflects on-disk existence of the project dir", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".git")); // project boundary → projectDir = dir/.zana

    const ctx = createForWorkspace(dir);
    // .zana not yet created → factory reports not initialized.
    expect(ctx.getProjectDir()).toBe(path.join(dir, ".zana"));
    expect(ctx.isInitialized()).toBe(false);

    // Bootstrap the project state dir → factory now reports initialized.
    fs.mkdirSync(ctx.getProjectDir());
    expect(ctx.isInitialized()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branch-parity regression — the singleton getProjectPaths() and the
// createForWorkspace() factory each independently hardcode the project-local
// path keys. CLAUDE.md's tenant-isolation invariant requires a new dir be
// added to BOTH branches; if it lands in only one, every other test still
// passes. This pins the two branches to the SAME key set so drift fails loudly.
// ---------------------------------------------------------------------------
describe("getProjectPaths() branch parity (singleton vs factory)", () => {
  it("singleton and createForWorkspace expose identical path-key sets", () => {
    const dir = makeTmpDir();
    // Plant .git so resolveProjectDir stops here for both branches, making the
    // projectDir (and thus the derived layout) identical and comparable.
    fs.mkdirSync(path.join(dir, ".git"));

    init(dir);
    const singletonKeys = Object.keys(getProjectPaths()).sort();
    const factoryKeys = Object.keys(createForWorkspace(dir).getProjectPaths()).sort();

    expect(factoryKeys).toEqual(singletonKeys);
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
    // Plant a .git dir so resolveProjectDir stops here instead of walking
    // up to a shared /tmp/.zana that may exist in this environment.
    fs.mkdirSync(path.join(dirA, ".git"));
    fs.mkdirSync(path.join(dirB, ".git"));

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
    // Plant a .git dir so resolveProjectDir stops here instead of walking
    // up to a shared /tmp/.zana that may exist in this environment.
    fs.mkdirSync(path.join(dirA, ".git"));
    fs.mkdirSync(path.join(dirB, ".git"));

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
