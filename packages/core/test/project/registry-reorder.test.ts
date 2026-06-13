// Focused test for reorder() in packages/core/src/project/registry.ts.
//
// reorder() had no dedicated coverage. It rewrites the persisted project
// order so the UI can present projects in a user-chosen sequence:
//   - entries are moved to match the given id order, and
//   - any entry NOT named in orderedIds is appended at the end in its
//     existing relative order, and
//   - ids that don't correspond to a known project are ignored.
//
// list() re-sorts (pinned-first, then lastOpenedAt desc), so it cannot
// observe raw ordering. We assert against the persisted projects.json
// array directly — that is the source of truth reorder() writes.
//
// Strategy mirrors registry.test.ts: redirect HOME to a tmpdir BEFORE any
// @zana-ai/* module loads so config.ts derives ZANA_DIR inside it. No
// internal modules are mocked. Fully deterministic — no network, no clock
// dependence (reorder does not read the clock).

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-reorder-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as registry from "../../src/project/registry.ts";

const registryPath = path.join(fakeHome, ".zana", "projects.json");

beforeAll(() => {
  fs.mkdirSync(path.join(fakeHome, ".zana"), { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

function makeProjectDir(suffix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zana-reorder-proj-${suffix}-`));
}

// Read the raw persisted order — the source of truth reorder() rewrites.
function persistedIds(): string[] {
  const data = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  return data.projects.map((p: any) => p.id);
}

describe("reorder()", () => {
  it("moves named entries to the front and appends the rest in existing order, ignoring unknown ids", () => {
    const dirs = ["a", "b", "c"].map(makeProjectDir);
    const [a, b, c] = dirs.map((d) => registry.importProject(d));

    // Imported in order a, b, c → persisted as [a, b, c].
    expect(persistedIds()).toEqual([a.id, b.id, c.id]);

    // Ask for c, then a, first; include a bogus id that must be ignored.
    // b is omitted entirely and must be appended at the end.
    registry.reorder([c.id, "proj_does_not_exist", a.id]);

    expect(persistedIds()).toEqual([c.id, a.id, b.id]);

    // cleanup
    [a, b, c].forEach((e) => registry.removeProject(e.id));
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  });
});
