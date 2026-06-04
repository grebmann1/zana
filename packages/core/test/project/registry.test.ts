// Integration test for packages/core/src/project/registry.ts.
//
// Strategy: redirect HOME to a tmpdir before any @zana-ai/* module loads, so
// `config.ts` derives ZANA_DIR/RECENT_WORKSPACES_PATH inside that tmpdir.
// No internal modules are mocked — the real registry persists JSON to and
// reads JSON from the tmpdir-backed paths.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-registry-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as registry from "../../src/project/registry.ts";

const fakeZanaDir = path.join(fakeHome, ".zana");

beforeAll(() => {
  fs.mkdirSync(fakeZanaDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

// helper: create a real tmpdir to act as a "project root"
function makeProjectDir(suffix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `zana-reg-proj-${suffix}-`));
  return d;
}

// ── list ─────────────────────────────────────────────────────────────────────

describe("list()", () => {
  it("returns an array (possibly empty if no projects have been imported yet)", () => {
    const result = registry.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── importProject ────────────────────────────────────────────────────────────

describe("importProject()", () => {
  it("creates a new entry with required fields and returns it", () => {
    const dir = makeProjectDir("import");
    const entry = registry.importProject(dir);

    expect(typeof entry.id).toBe("string");
    expect(entry.id.startsWith("proj_")).toBe(true);
    expect(entry.path).toBe(path.resolve(dir));
    expect(typeof entry.name).toBe("string");
    expect(entry.status).toBe("active");
    expect(entry.pinned).toBe(false);
    expect(typeof entry.addedAt).toBe("string");
    expect(typeof entry.lastOpenedAt).toBe("string");

    // cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates by path — second import returns the same entry id", () => {
    const dir = makeProjectDir("dedup");
    const first  = registry.importProject(dir);
    const second = registry.importProject(dir);
    expect(second.id).toBe(first.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-activates an archived project on re-import", () => {
    const dir = makeProjectDir("reactivate");
    const entry = registry.importProject(dir);
    registry.archiveProject(entry.id);
    expect(registry.getById(entry.id)?.status).toBe("archived");

    const reactivated = registry.importProject(dir);
    expect(reactivated.id).toBe(entry.id);
    expect(reactivated.status).toBe("active");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── getById / getByPath ───────────────────────────────────────────────────────

describe("getById() and getByPath()", () => {
  it("getById returns null for an unknown id", () => {
    expect(registry.getById("proj_doesnotexist")).toBeNull();
  });

  it("getByPath returns null for an unregistered path", () => {
    expect(registry.getByPath("/no/such/path/here")).toBeNull();
  });

  it("round-trips: getById and getByPath find the imported entry", () => {
    const dir = makeProjectDir("roundtrip");
    const entry = registry.importProject(dir);

    const byId   = registry.getById(entry.id);
    const byPath = registry.getByPath(dir);

    expect(byId?.id).toBe(entry.id);
    expect(byPath?.id).toBe(entry.id);
    expect(byPath?.path).toBe(path.resolve(dir));

    registry.removeProject(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── removeProject ─────────────────────────────────────────────────────────────

describe("removeProject()", () => {
  it("returns false when the project does not exist", () => {
    expect(registry.removeProject("proj_ghost")).toBe(false);
  });

  it("removes the entry and returns true", () => {
    const dir = makeProjectDir("remove");
    const entry = registry.importProject(dir);
    expect(registry.removeProject(entry.id)).toBe(true);
    expect(registry.getById(entry.id)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── togglePin / sort order ────────────────────────────────────────────────────

describe("togglePin() and list() sort order", () => {
  it("togglePin flips the pinned flag", () => {
    const dir = makeProjectDir("pin");
    const entry = registry.importProject(dir);
    expect(entry.pinned).toBe(false);

    const pinned   = registry.togglePin(entry.id);
    expect(pinned?.pinned).toBe(true);

    const unpinned = registry.togglePin(entry.id);
    expect(unpinned?.pinned).toBe(false);

    registry.removeProject(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pinned projects appear before unpinned in list()", () => {
    const dirA = makeProjectDir("sort-a");
    const dirB = makeProjectDir("sort-b");
    const a = registry.importProject(dirA, { name: "alpha" });
    const b = registry.importProject(dirB, { name: "beta" });

    // Pin 'a' only.
    registry.togglePin(a.id);

    const listed = registry.list();
    const ids = listed.map((p) => p.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));

    registry.removeProject(a.id);
    registry.removeProject(b.id);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });
});

// ── archiveProject ────────────────────────────────────────────────────────────

describe("archiveProject()", () => {
  it("sets status to 'archived'", () => {
    const dir = makeProjectDir("archive");
    const entry = registry.importProject(dir);
    registry.archiveProject(entry.id);
    expect(registry.getById(entry.id)?.status).toBe("archived");
    registry.removeProject(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("archived project does not appear in list() but appears in list({ status: 'archived' })", () => {
    const dir = makeProjectDir("archive-list");
    const entry = registry.importProject(dir);
    registry.archiveProject(entry.id);

    const active   = registry.list().map((p) => p.id);
    const archived = registry.list({ status: "archived" }).map((p) => p.id);

    expect(active).not.toContain(entry.id);
    expect(archived).toContain(entry.id);

    registry.removeProject(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── updateProject ─────────────────────────────────────────────────────────────

describe("updateProject()", () => {
  it("updates allowed fields (name, color, tags, pinned)", () => {
    const dir = makeProjectDir("update");
    const entry = registry.importProject(dir);

    const updated = registry.updateProject(entry.id, {
      name: "Renamed",
      color: "#ff0000",
      tags: ["infra", "prod"],
      pinned: true,
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.color).toBe("#ff0000");
    expect(updated?.tags).toEqual(["infra", "prod"]);
    expect(updated?.pinned).toBe(true);

    registry.removeProject(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an unknown id", () => {
    expect(registry.updateProject("proj_unknown", { name: "x" })).toBeNull();
  });
});
