// Focused test for packages/work/src/teams/store.ts id sanitization on read.
// saveTeam REJECTS ids with characters outside [a-zA-Z0-9_-], but getTeam and
// deleteTeam silently sanitize the id before joining it onto TEAMS_DIR. This
// pins the path-traversal-resistance invariant: a dirty id like "../../evil"
// is stripped to a plain name and can never resolve to a file outside
// TEAMS_DIR.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { TEAMS_DIR } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  return {
    TEAMS_DIR: nodePath.join(
      nodeOs.tmpdir(),
      `zana-test-teams-sanitize-${Date.now()}-${process.pid}`
    ),
  };
});

vi.mock("@zana-ai/core", () => ({
  config: { TEAMS_DIR },
}));

import { saveTeam, getTeam, deleteTeam } from "@zana-ai/work/src/teams/store.ts";

describe("teams/store — id sanitization on read", () => {
  beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
  afterEach(() => {
    try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {}
    // Clean up any stray file that a traversal would have created/read.
    try { fs.rmSync(path.join(TEAMS_DIR, "..", "evil.json"), { force: true }); } catch {}
  });

  it("getTeam strips traversal characters, resolving a dirty id to a file inside TEAMS_DIR", () => {
    // Saved under the clean, sanitized id.
    saveTeam({ id: "evil", name: "Sanitized Team", slots: [] });

    // "../../evil" → sanitizeId removes dots and slashes → "evil".
    const team = getTeam("../../evil");
    expect(team).not.toBeNull();
    expect(team.id).toBe("evil");
    expect(team.name).toBe("Sanitized Team");
  });

  it("getTeam never reads a file outside TEAMS_DIR", () => {
    // Plant a file one directory ABOVE TEAMS_DIR. A naive join of "../evil"
    // would read it; sanitization collapses the id to "evil" and stays inside.
    const outside = path.join(TEAMS_DIR, "..", "evil.json");
    fs.writeFileSync(outside, JSON.stringify({ id: "evil", name: "Outside" }), "utf8");

    expect(getTeam("../evil")).toBeNull();
  });

  it("deleteTeam sanitizes the id before unlinking", () => {
    saveTeam({ id: "deletable", name: "Bye", slots: [] });
    expect(getTeam("deletable")).not.toBeNull();

    // Dirty id maps to the same sanitized "deletable" file.
    expect(deleteTeam("../deletable")).toBe(true);
    expect(getTeam("deletable")).toBeNull();
  });
});
