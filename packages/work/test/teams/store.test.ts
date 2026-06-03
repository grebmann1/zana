// Tests for packages/work/src/teams/store.ts
// Covers saveTeam normalization: defaults, slot clamping, id validation,
// workerProfileIds deduplication, and rules.maxConcurrentWorkers derivation.
// @zana-ai/core is mocked to an isolated temp dir — no global ~/.zana writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── redirect TEAMS_DIR to an isolated temp directory ─────────────────────
// vi.hoisted runs before the vi.mock factory (which is itself hoisted above
// imports), so the temp path is available when the mock initializes. Use
// require() instead of imports inside hoisted because imports aren't bound
// yet at hoist time.
const { TEAMS_DIR } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  return {
    TEAMS_DIR: nodePath.join(
      nodeOs.tmpdir(),
      `zana-test-teams-store-${Date.now()}-${process.pid}`
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

// ── fixtures ──────────────────────────────────────────────────────────────

function freshTeam(overrides: Record<string, unknown> = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return { id: `team-${suffix}`, name: "Test Team", slots: [], ...overrides };
}

// ── lifecycle ─────────────────────────────────────────────────────────────

describe("teams/store — saveTeam", () => {
  beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
  afterEach(() =>  { try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {} });

  // ── defaults ────────────────────────────────────────────────────────────

  it("fills in default name, icon, and orchestratorProfileId when absent", () => {
    const team = saveTeam({ slots: [] });
    expect(team.name).toBe("Untitled Team");
    expect(team.icon).toBe("🏗️");
    expect(team.orchestratorProfileId).toBe("orchestrator");
  });

  it("preserves caller-supplied name and icon", () => {
    const team = saveTeam(freshTeam({ name: "My Squad", icon: "🚀" }));
    expect(team.name).toBe("My Squad");
    expect(team.icon).toBe("🚀");
  });

  it("initialises default boolean flags to false", () => {
    const team = saveTeam(freshTeam());
    expect(team.rules.autoRestart).toBe(false);
    expect(team.rules.requireApproval).toBe(false);
    expect(team.autoStart).toBe(false);
    expect(team.dynamicSpawning).toBe(false);
  });

  // ── id validation ────────────────────────────────────────────────────────

  it("rejects an id that contains characters outside [a-zA-Z0-9_-]", () => {
    expect(() => saveTeam({ id: "bad id!", name: "Bad" })).toThrow(/invalid team\.id/);
    expect(() => saveTeam({ id: "no/slash", name: "Bad" })).toThrow(/invalid team\.id/);
    expect(() => saveTeam({ id: "dot.dot", name: "Bad" })).toThrow(/invalid team\.id/);
  });

  it("accepts ids with letters, digits, hyphens, and underscores", () => {
    const team = saveTeam({ id: "valid-id_123", name: "Valid" });
    expect(team.id).toBe("valid-id_123");
  });

  // ── slot normalization ───────────────────────────────────────────────────

  it("filters out slots whose quantity is below 1", () => {
    const team = saveTeam(freshTeam({
      slots: [
        { profileId: "ghost", quantity: 0 },
        { profileId: "keeper", quantity: 2 },
      ],
    }));
    expect(team.slots.find((s) => s.profileId === "ghost")).toBeUndefined();
    expect(team.slots.find((s) => s.profileId === "keeper")?.quantity).toBe(2);
  });

  it("clamps slot quantity to a maximum of 10", () => {
    const team = saveTeam(freshTeam({
      slots: [{ profileId: "army", quantity: 99 }],
    }));
    expect(team.slots[0].quantity).toBe(10);
  });

  it("rounds fractional quantities that pass the ≥1 filter (1.7 → 2)", () => {
    // The filter requires quantity >= 1 first, then rounds. So 0.5 is filtered
    // out, but 1.7 (passes filter) is rounded to 2.
    const team = saveTeam(freshTeam({
      slots: [
        { profileId: "frac", quantity: 1.7 },
        { profileId: "below", quantity: 0.5 }, // filtered out, not rounded
      ],
    }));
    expect(team.slots.find((s) => s.profileId === "frac")?.quantity).toBe(2);
    expect(team.slots.find((s) => s.profileId === "below")).toBeUndefined();
  });

  // ── workerProfileIds deduplication ───────────────────────────────────────

  it("derives workerProfileIds from slots with duplicates removed", () => {
    const team = saveTeam(freshTeam({
      slots: [
        { profileId: "coder",    quantity: 2 },
        { profileId: "coder",    quantity: 1 }, // duplicate
        { profileId: "reviewer", quantity: 1 },
      ],
    }));
    expect(team.workerProfileIds).toEqual(["coder", "reviewer"]);
  });

  it("builds default slots from workerProfileIds when no slots provided", () => {
    const team = saveTeam(freshTeam({
      workerProfileIds: ["coder", "tester"],
      slots: undefined,
    }));
    expect(team.slots).toHaveLength(2);
    expect(team.slots.every((s) => s.quantity === 1)).toBe(true);
  });

  // ── rules.maxConcurrentWorkers ──────────────────────────────────────────

  it("derives maxConcurrentWorkers from total slot quantity (≥ 3)", () => {
    const team = saveTeam(freshTeam({
      slots: [
        { profileId: "coder",    quantity: 4 },
        { profileId: "reviewer", quantity: 2 },
      ],
    }));
    expect(team.rules.maxConcurrentWorkers).toBe(6); // max(3, 4+2)
  });

  it("enforces a minimum of 3 for maxConcurrentWorkers", () => {
    const team = saveTeam(freshTeam({
      slots: [{ profileId: "solo", quantity: 1 }],
    }));
    expect(team.rules.maxConcurrentWorkers).toBe(3); // max(3, 1)
  });

  it("respects a caller-supplied maxConcurrentWorkers", () => {
    const team = saveTeam(freshTeam({
      slots: [{ profileId: "worker", quantity: 2 }],
      rules: { maxConcurrentWorkers: 8 },
    }));
    expect(team.rules.maxConcurrentWorkers).toBe(8);
  });

  // ── persistence round-trip ───────────────────────────────────────────────

  it("persists a team to disk and retrieves it by id", () => {
    const saved = saveTeam(freshTeam({ id: "persist-rt", name: "Roundtrip" }));
    const loaded = getTeam("persist-rt");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(saved.id);
    expect(loaded?.name).toBe("Roundtrip");
  });

  it("listTeams includes the saved team", () => {
    saveTeam(freshTeam({ id: "list-me", name: "Listed" }));
    const all = listTeams();
    expect(all.some((t) => t.id === "list-me")).toBe(true);
  });

  it("deleteTeam removes the file; getTeam returns null afterwards", () => {
    saveTeam(freshTeam({ id: "del-me", name: "Delete Me" }));
    expect(getTeam("del-me")).not.toBeNull();
    const removed = deleteTeam("del-me");
    expect(removed).toBe(true);
    expect(getTeam("del-me")).toBeNull();
  });

  it("deleteTeam returns false for a non-existent id", () => {
    expect(deleteTeam("does-not-exist")).toBe(false);
  });
});
