// Additional edge-case tests for packages/work/src/teams/store.ts.
// Covers: null-id guards, corrupt-JSON tolerance, maxTotalWorkers derivation,
// slot filtering for missing profileId, and initialPrompt default.

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
      `zana-test-teams-edge-${Date.now()}-${process.pid}`
    ),
  };
});

vi.mock("@zana-ai/core", () => ({
  config: { TEAMS_DIR },
}));

import {
  saveTeam,
  getTeam,
  listTeams,
  deleteTeam,
} from "@zana-ai/work/src/teams/store.ts";

function freshId() {
  return `edge-${Math.random().toString(36).slice(2, 8)}`;
}

describe("teams/store — edge cases", () => {
  beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
  afterEach(() => {
    try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {}
  });

  // ── null-id guards ───────────────────────────────────────────────────────

  it("getTeam(null) returns null without touching the filesystem", () => {
    expect(getTeam(null)).toBeNull();
  });

  it("getTeam(undefined) returns null", () => {
    expect(getTeam(undefined as any)).toBeNull();
  });

  it("deleteTeam(null) returns false without throwing", () => {
    expect(deleteTeam(null as any)).toBe(false);
  });

  // ── listTeams tolerates corrupt JSON ────────────────────────────────────

  it("listTeams skips files with invalid JSON and returns the rest", () => {
    const id = freshId();
    saveTeam({ id, name: "Good Team", slots: [] });
    // Plant a corrupt .json file alongside the valid one
    fs.writeFileSync(path.join(TEAMS_DIR, "corrupt.json"), "{ bad json }", "utf8");

    const teams = listTeams();
    expect(teams.some((t) => t.id === id)).toBe(true);
    // Corrupt file must be silently dropped — no null entries
    expect(teams.every((t) => t !== null)).toBe(true);
  });

  // ── maxTotalWorkers derivation ───────────────────────────────────────────

  it("saveTeam derives maxTotalWorkers from maxConcurrentWorkers when absent", () => {
    const team = saveTeam({
      id: freshId(),
      name: "Auto maxTotalWorkers",
      slots: [{ profileId: "coder", quantity: 4 }],
    });
    // maxConcurrentWorkers = max(3, 4) = 4; maxTotalWorkers should mirror it
    expect(team.maxTotalWorkers).toBe(team.rules.maxConcurrentWorkers);
    expect(team.maxTotalWorkers).toBe(4);
  });

  it("saveTeam respects a caller-supplied maxTotalWorkers", () => {
    const team = saveTeam({
      id: freshId(),
      name: "Explicit maxTotalWorkers",
      slots: [],
      maxTotalWorkers: 20,
    });
    expect(team.maxTotalWorkers).toBe(20);
  });

  // ── slot filtering: missing profileId ────────────────────────────────────

  it("saveTeam filters out slots with no profileId", () => {
    const team = saveTeam({
      id: freshId(),
      name: "Partial slots",
      slots: [
        { profileId: "", quantity: 2 },      // empty string — falsy
        { quantity: 3 } as any,              // missing profileId entirely
        { profileId: "keeper", quantity: 1 },
      ],
    });
    expect(team.slots).toHaveLength(1);
    expect(team.slots[0].profileId).toBe("keeper");
  });

  // ── initialPrompt default ────────────────────────────────────────────────

  it("saveTeam defaults initialPrompt to empty string when absent", () => {
    const team = saveTeam({ id: freshId(), name: "No prompt", slots: [] });
    expect(team.initialPrompt).toBe("");
  });
});
