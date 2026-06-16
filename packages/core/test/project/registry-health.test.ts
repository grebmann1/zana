// Coverage for checkHealth()/checkAllHealth() in src/project/registry.ts.
// Mirrors registry.test.ts: redirect HOME to a tmpdir before any @zana-ai/*
// module loads so config.ts derives ZANA_DIR inside it, then drive the real
// registry against real tmpdir-backed project dirs. Deterministic — no
// network, no clock, no shared state outside per-test tmpdirs.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-reg-health-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as registry from "../../src/project/registry.ts";
import { initProjectDir } from "../../src/project/init.ts";

const createdDirs: string[] = [];
function makeProjectDir(suffix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `zana-health-${suffix}-`));
  // .git marks the project boundary so resolveProjectDir's upward walk can't
  // escape into the shared tmp parent (which may hold a stray .zana) and
  // misreport a missing project state dir as present.
  fs.mkdirSync(path.join(d, ".git"));
  createdDirs.push(d);
  return d;
}

beforeAll(() => {
  fs.mkdirSync(path.join(fakeHome, ".zana"), { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  for (const d of createdDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("checkHealth()", () => {
  it("returns all-false for an unknown project id", () => {
    expect(registry.checkHealth("proj_doesnotexist")).toEqual({
      exists: false,
      projectInitialized: false,
      configValid: false,
    });
  });

  it("reports exists:true but uninitialized when the .zana dir is missing", () => {
    const dir = makeProjectDir("bare");
    const entry = registry.importProject(dir);
    // importProject auto-initializes; simulate a degraded project whose path
    // still exists but whose .zana/ has been removed.
    fs.rmSync(path.join(dir, ".zana"), { recursive: true, force: true });

    const health = registry.checkHealth(entry.id);
    expect(health.exists).toBe(true);
    expect(health.projectInitialized).toBe(false);
    expect(health.configValid).toBe(false);

    registry.removeProject(entry.id);
  });

  it("reports fully healthy for an initialized project with a valid config", () => {
    const dir = makeProjectDir("healthy");
    initProjectDir(dir, { silent: true });
    const entry = registry.importProject(dir);

    expect(registry.checkHealth(entry.id)).toEqual({
      exists: true,
      projectInitialized: true,
      configValid: true,
    });

    registry.removeProject(entry.id);
  });

  it("reports configValid:false when config.json is corrupt JSON", () => {
    const dir = makeProjectDir("badconfig");
    initProjectDir(dir, { silent: true });
    // Corrupt the config the registry will try to parse.
    const configPath = path.join(dir, ".zana", "config.json");
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    const entry = registry.importProject(dir);

    const health = registry.checkHealth(entry.id);
    expect(health.exists).toBe(true);
    expect(health.configValid).toBe(false);

    registry.removeProject(entry.id);
  });

  it("reports exists:false when the project path has been deleted", () => {
    const dir = makeProjectDir("vanished");
    const entry = registry.importProject(dir);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(registry.checkHealth(entry.id)).toEqual({
      exists: false,
      projectInitialized: false,
      configValid: false,
    });

    registry.removeProject(entry.id);
  });
});

describe("checkAllHealth()", () => {
  it("includes active projects keyed by id and excludes archived ones", () => {
    const activeDir = makeProjectDir("all-active");
    const archivedDir = makeProjectDir("all-archived");
    const active = registry.importProject(activeDir);
    const archived = registry.importProject(archivedDir);
    registry.archiveProject(archived.id);

    const results = registry.checkAllHealth();

    expect(results[active.id]).toBeDefined();
    expect(results[active.id].exists).toBe(true);
    expect(results[archived.id]).toBeUndefined();

    registry.removeProject(active.id);
    registry.removeProject(archived.id);
  });
});
