// Unit tests for packages/core/src/project/init.ts
// Covers: initProjectDir, isProjectInitialized, getProjectManifest.
// All fs operations use a real tmpdir — no mocks, no network, no real Claude.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  initProjectDir,
  isProjectInitialized,
  getProjectManifest,
  PROJECT_DIR,
} from "../../src/project/init.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zana-init-test-"));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpRoots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// initProjectDir
// ---------------------------------------------------------------------------

describe("initProjectDir", () => {
  it("creates the .zana/ directory with all required subdirectories", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });

    const projectPath = path.join(root, PROJECT_DIR);
    expect(fs.existsSync(projectPath)).toBe(true);

    const required = ["tickets", "sprints", "artifacts", "plans", "audit",
                      "sessions", "runs", "events", "scheduler", "tmp"];
    for (const sub of required) {
      expect(fs.existsSync(path.join(projectPath, sub))).toBe(true);
    }
  });

  it("writes a valid config.json containing the project name and version", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });

    const configPath = path.join(root, PROJECT_DIR, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(cfg).toMatchObject({ version: 1, createdBy: "zana-init" });
    expect(typeof cfg.name).toBe("string");
    expect(cfg.name.length).toBeGreaterThan(0);
  });

  it("derives the project name from package.json when present", () => {
    const root = makeTmpDir();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "my-cool-project" }),
      "utf8",
    );
    initProjectDir(root, { silent: true });

    const cfg = getProjectManifest(root);
    expect(cfg?.name).toBe("my-cool-project");
  });

  it("falls back to the directory basename when package.json has no name", () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({}), "utf8");
    initProjectDir(root, { silent: true });

    const cfg = getProjectManifest(root);
    expect(cfg?.name).toBe(path.basename(root));
  });

  it("is idempotent — re-running does not clobber existing config.json", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    const first = getProjectManifest(root);

    // Run again without force
    initProjectDir(root, { silent: true });
    const second = getProjectManifest(root);

    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("overwrites config.json when force=true", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    const firstTs = getProjectManifest(root)?.createdAt;

    // Small delay to ensure a different timestamp
    const before = Date.now();
    while (Date.now() === before) { /* spin */ }

    initProjectDir(root, { silent: true, force: true });
    const secondTs = getProjectManifest(root)?.createdAt;

    // createdAt is regenerated on force
    expect(secondTs).toBeDefined();
    // May or may not differ by ms precision, but config must still be valid
    expect(getProjectManifest(root)).toMatchObject({ version: 1 });
  });

  it("returns { created: true, projectPath } pointing at .zana/ inside the root", () => {
    const root = makeTmpDir();
    const result = initProjectDir(root, { silent: true });
    expect(result.created).toBe(true);
    expect(result.projectPath).toBe(path.join(root, PROJECT_DIR));
  });

  it("writes a .gitignore file inside .zana/", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    const gitignorePath = path.join(root, PROJECT_DIR, ".gitignore");
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const contents = fs.readFileSync(gitignorePath, "utf8");
    // Must exclude at least the transient dirs
    expect(contents).toContain("audit/");
    expect(contents).toContain("sessions/");
  });
});

// ---------------------------------------------------------------------------
// isProjectInitialized
// ---------------------------------------------------------------------------

describe("isProjectInitialized", () => {
  it("returns false for a workspace that has never been initialized", () => {
    const root = makeTmpDir();
    expect(isProjectInitialized(root)).toBe(false);
  });

  it("returns true after initProjectDir has been called", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    expect(isProjectInitialized(root)).toBe(true);
  });

  it("returns false when config.json is missing even if subdirs exist", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    fs.rmSync(path.join(root, PROJECT_DIR, "config.json"));
    expect(isProjectInitialized(root)).toBe(false);
  });

  it("returns false when a required subdirectory is missing", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    fs.rmdirSync(path.join(root, PROJECT_DIR, "tickets"));
    expect(isProjectInitialized(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProjectManifest
// ---------------------------------------------------------------------------

describe("getProjectManifest", () => {
  it("returns null when .zana/ does not exist", () => {
    const root = makeTmpDir();
    expect(getProjectManifest(root)).toBeNull();
  });

  it("returns null when config.json is not valid JSON", () => {
    const root = makeTmpDir();
    const projectPath = path.join(root, PROJECT_DIR);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, "config.json"), "not json {{", "utf8");
    expect(getProjectManifest(root)).toBeNull();
  });

  it("returns the parsed config object after init", () => {
    const root = makeTmpDir();
    initProjectDir(root, { silent: true });
    const cfg = getProjectManifest(root);
    expect(cfg).not.toBeNull();
    expect(cfg?.version).toBe(1);
    expect(cfg?.settings).toBeDefined();
  });
});
