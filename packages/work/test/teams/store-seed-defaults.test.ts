// Tests for the previously untested exports of packages/work/src/teams/store.ts:
//   • getTemplates()   — returns built-in templates; plugin-loader failure silenced
//   • seedDefaults()   — seeds team files + .seeded marker on first call;
//                        idempotent; respects the marker for user-deleted templates.
//
// All I/O is redirected to an isolated temp dir — no global ~/.zana writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { TEAMS_DIR } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  return {
    TEAMS_DIR: nodePath.join(
      nodeOs.tmpdir(),
      `zana-test-seed-${Date.now()}-${process.pid}`
    ),
  };
});

vi.mock("@zana-ai/core", () => ({
  config: { TEAMS_DIR },
}));

import {
  getTemplates,
  seedDefaults,
} from "@zana-ai/work/src/teams/store.ts";

// ---------------------------------------------------------------------------
// getTemplates
// ---------------------------------------------------------------------------
describe("teams/store — getTemplates", () => {
  it("returns at least one built-in template even when the plugin loader is absent", () => {
    // @zana-ai/extras is not available in the test environment; the try/catch
    // inside getTemplates silences the require() failure and falls back to
    // the hardcoded TEAM_TEMPLATES array.
    const templates = getTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });

  it("every template has a non-empty name, an orchestratorProfileId, and a slots array", () => {
    for (const t of getTemplates()) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.orchestratorProfileId).toBe("string");
      expect(Array.isArray(t.slots)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// seedDefaults
// ---------------------------------------------------------------------------
describe("teams/store — seedDefaults", () => {
  beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
  afterEach(() => {
    try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {}
  });

  it("creates one JSON file per built-in template on first call", () => {
    seedDefaults();
    const jsonFiles = fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBe(getTemplates().length);
  });

  it("writes a .seeded marker whose entries equal the built-in template count", () => {
    seedDefaults();
    const markerPath = path.join(TEAMS_DIR, ".seeded");
    expect(fs.existsSync(markerPath)).toBe(true);
    const seeded: string[] = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded.length).toBe(getTemplates().length);
  });

  it("is idempotent — calling twice does not multiply files or marker entries", () => {
    seedDefaults();
    const count1 = fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json")).length;
    const marker1: string[] = JSON.parse(
      fs.readFileSync(path.join(TEAMS_DIR, ".seeded"), "utf8"),
    );
    seedDefaults();
    const count2 = fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json")).length;
    const marker2: string[] = JSON.parse(
      fs.readFileSync(path.join(TEAMS_DIR, ".seeded"), "utf8"),
    );
    expect(count2).toBe(count1);
    expect(marker2).toEqual(marker1);
  });

  it("does NOT recreate a template file that was deleted after initial seeding", () => {
    // A user who deletes a built-in team should not see it silently reappear
    // on the next daemon boot — the .seeded marker must gate recreation.
    seedDefaults();
    const jsonFiles = fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json"));
    const victim = path.join(TEAMS_DIR, jsonFiles[0]);
    fs.unlinkSync(victim);

    // Second call: the id is already in .seeded → seedDefaults must skip it.
    seedDefaults();
    expect(fs.existsSync(victim)).toBe(false);
  });
});
