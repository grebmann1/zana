// seedDefaults() — corrupt/unreadable .seeded marker recovery.
//
// packages/work/src/teams/store.ts seedDefaults() (lines ~245-251):
//
//   let seeded;
//   try {
//     seeded = new Set(JSON.parse(fs.readFileSync(markerPath, "utf8")));
//   } catch {
//     seeded = new Set();   // ← corrupt / unreadable marker → treat as "nothing seeded"
//   }
//
// The existing store-seed-defaults test only exercises the happy path (valid
// marker, idempotent re-run, user-deleted-template gate). This file pins the
// catch branch: when the .seeded marker is not valid JSON, seedDefaults must
// fall back to an empty set, re-seed all built-in templates, and overwrite the
// marker with a well-formed one — never throw.
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
      `zana-test-seed-corrupt-${Date.now()}-${process.pid}`,
    ),
  };
});

vi.mock("@zana-ai/core", () => ({
  config: { TEAMS_DIR },
}));

import { getTemplates, seedDefaults } from "@zana-ai/work/src/teams/store.ts";

const markerPath = () => path.join(TEAMS_DIR, ".seeded");

beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
afterEach(() => {
  try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {}
});

describe("teams/store — seedDefaults with a corrupt .seeded marker", () => {
  it("does not throw when the marker is not valid JSON", () => {
    fs.writeFileSync(markerPath(), "{ this is not json", "utf8");
    expect(() => seedDefaults()).not.toThrow();
  });

  it("treats a corrupt marker as empty and seeds every built-in template", () => {
    // A corrupt marker must not suppress seeding — otherwise a single byte of
    // corruption would permanently strand the workspace with zero teams.
    fs.writeFileSync(markerPath(), "<<<garbage>>>", "utf8");

    seedDefaults();

    const jsonFiles = fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBe(getTemplates().length);
  });

  it("overwrites the corrupt marker with a well-formed JSON array", () => {
    fs.writeFileSync(markerPath(), "not-json-at-all", "utf8");

    seedDefaults();

    const raw = fs.readFileSync(markerPath(), "utf8");
    const parsed = JSON.parse(raw); // must not throw — marker was rewritten
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(getTemplates().length);
  });
});
