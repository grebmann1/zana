// Tests for the sprint half of packages/work/src/tickets/store.ts
// (JSON file-based store, not the SQLite db.ts path).
//
// store.test.ts covers all ticket operations but has no sprint tests at all.
// Covered here:
//   • saveSprint / getSprint round-trip
//   • saveSprint acts as upsert
//   • getSprint returns null for unknown id
//   • listSprints — no filter, status filter, teamId filter, daemonId filter
//   • deleteSprint returns true and removes the file; false for missing id
//   • listSprints hiveId → daemonId on-read migration
//   • listSprints silently skips malformed JSON files

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/tickets/store.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function getSprintsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().sprintsDir;
}

let seq = 0;
function uid() { return `sp-${Date.now()}-${++seq}`; }

function makeSprint(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `S-${uid()}`,
    name: "Test sprint",
    status: "planning",
    ticketIds: [] as string[],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── workspace setup / teardown ─────────────────────────────────────────────

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-store-sprints-${Date.now()}-${process.pid}`
  );
  // Pre-create .zana/ so resolveProjectDir() stops here.
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

// ── saveSprint / getSprint ─────────────────────────────────────────────────

describe("saveSprint / getSprint", () => {
  it("persists a sprint and retrieves it by id", () => {
    const s = makeSprint({ name: "Alpha Sprint" });
    store.saveSprint(s);
    const fetched = store.getSprint(s.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(s.id);
    expect(fetched!.name).toBe("Alpha Sprint");
    expect(fetched!.status).toBe("planning");
  });

  it("getSprint returns null for an unknown id", () => {
    expect(store.getSprint("no-such-sprint-xyzzy")).toBeNull();
  });

  it("saveSprint acts as upsert — overwrites on re-save", () => {
    const s = makeSprint({ name: "Original" });
    store.saveSprint(s);
    store.saveSprint({ ...s, name: "Updated", status: "active" });
    const fetched = store.getSprint(s.id);
    expect(fetched!.name).toBe("Updated");
    expect(fetched!.status).toBe("active");
  });

  it("round-trips a non-empty ticketIds array", () => {
    const s = makeSprint({ ticketIds: ["T-1", "T-2", "T-3"] });
    store.saveSprint(s);
    const fetched = store.getSprint(s.id);
    expect(fetched!.ticketIds).toEqual(["T-1", "T-2", "T-3"]);
  });
});

// ── listSprints ────────────────────────────────────────────────────────────

describe("listSprints — unfiltered", () => {
  it("returns all saved sprints", () => {
    const a = makeSprint({ name: "Sprint A" });
    const b = makeSprint({ name: "Sprint B" });
    store.saveSprint(a);
    store.saveSprint(b);
    const ids = store.listSprints().map((s: any) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("returns [] when no sprints have been saved", () => {
    expect(store.listSprints()).toEqual([]);
  });
});

describe("listSprints — status filter", () => {
  it("returns only sprints with the matching status", () => {
    const active  = makeSprint({ status: "active" });
    const closed  = makeSprint({ status: "closed" });
    store.saveSprint(active);
    store.saveSprint(closed);

    const results = store.listSprints({ status: "active" });
    const ids = results.map((s: any) => s.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(closed.id);
    expect(results.every((s: any) => s.status === "active")).toBe(true);
  });
});

describe("listSprints — teamId filter", () => {
  it("returns only sprints owned by the given team", () => {
    const teamId = `team-${uid()}`;
    const inTeam = makeSprint({ teamId });
    const other  = makeSprint({ teamId: `team-other-${uid()}` });
    store.saveSprint(inTeam);
    store.saveSprint(other);

    const results = store.listSprints({ teamId });
    const ids = results.map((s: any) => s.id);
    expect(ids).toContain(inTeam.id);
    expect(ids).not.toContain(other.id);
    expect(results.every((s: any) => s.teamId === teamId)).toBe(true);
  });
});

describe("listSprints — daemonId filter", () => {
  it("returns only sprints for the given daemon", () => {
    const daemonId = `daemon-${uid()}`;
    const mine  = makeSprint({ daemonId });
    const other = makeSprint({ daemonId: `daemon-other-${uid()}` });
    store.saveSprint(mine);
    store.saveSprint(other);

    const results = store.listSprints({ daemonId });
    const ids = results.map((s: any) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });
});

// ── deleteSprint ───────────────────────────────────────────────────────────

describe("deleteSprint", () => {
  it("removes the sprint file and returns true", () => {
    const s = makeSprint();
    store.saveSprint(s);
    expect(store.deleteSprint(s.id)).toBe(true);
    expect(store.getSprint(s.id)).toBeNull();
  });

  it("deleted sprint no longer appears in listSprints", () => {
    const s = makeSprint();
    store.saveSprint(s);
    store.deleteSprint(s.id);
    expect(store.listSprints().map((x: any) => x.id)).not.toContain(s.id);
  });

  it("returns false for a non-existent id", () => {
    expect(store.deleteSprint("ghost-sprint-never-existed")).toBe(false);
  });
});

// ── hiveId → daemonId migration in listSprints ─────────────────────────────

describe("listSprints — hiveId → daemonId on-read migration", () => {
  it("exposes a legacy hiveId field as daemonId and removes hiveId", () => {
    // Write a sprint file directly using the old `hiveId` field (pre-migration).
    const sprintsDir = getSprintsDir();
    fs.mkdirSync(sprintsDir, { recursive: true });

    const id = `S-legacy-${uid()}`;
    const now = new Date().toISOString();
    const legacy = {
      id,
      name: "Legacy sprint",
      status: "planning",
      hiveId: "daemon-old",
      ticketIds: [],
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(
      path.join(sprintsDir, `${id}.json`),
      JSON.stringify(legacy, null, 2),
      "utf8"
    );

    const results = store.listSprints();
    const found = results.find((s: any) => s.id === id);

    expect(found).not.toBeUndefined();
    // Migration: daemonId must equal the old hiveId value.
    expect(found!.daemonId).toBe("daemon-old");
    // hiveId must be removed.
    expect((found as any).hiveId).toBeUndefined();
  });
});

// ── malformed files are skipped ────────────────────────────────────────────

describe("listSprints — malformed file handling", () => {
  it("silently skips a sprint file that contains invalid JSON", () => {
    const s = makeSprint({ name: "Good sprint" });
    store.saveSprint(s);

    const sprintsDir = getSprintsDir();
    fs.writeFileSync(path.join(sprintsDir, "corrupt.json"), "{ bad json {{", "utf8");

    const results = store.listSprints();
    const ids = results.map((x: any) => x.id);
    expect(ids).toContain(s.id);
    // The corrupt file must not produce a null/undefined entry.
    expect(results.every((x: any) => x !== null && x !== undefined)).toBe(true);
  });
});
