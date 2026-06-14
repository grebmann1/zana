// Focused test for registry.touchProject() — the one exported registry
// function with no direct coverage (importProject/list/getById/removeProject/
// togglePin/updateProject/archiveProject/checkHealth/reorder are all exercised
// by registry.test.ts, registry-health.test.ts, registry-reorder.test.ts).
//
// Strategy mirrors registry.test.ts: redirect HOME to a tmpdir before any
// @zana-ai/* module loads so config.ts derives ZANA_DIR inside the tmpdir, and
// let the real registry persist/read JSON. Time is driven via fake timers so
// the lastOpenedAt update is deterministic (no same-millisecond flake).

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-registry-touch-home-"));
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

function makeProjectDir(suffix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zana-reg-touch-${suffix}-`));
}

describe("touchProject()", () => {
  it("updates lastOpenedAt to the current time and persists it", () => {
    const dir = makeProjectDir("update");
    const entry = registry.importProject(dir);
    const before = entry.lastOpenedAt;

    vi.useFakeTimers();
    try {
      const later = new Date(Date.parse(before) + 60_000);
      vi.setSystemTime(later);

      registry.touchProject(entry.id);

      const reloaded = registry.getById(entry.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded.lastOpenedAt).toBe(later.toISOString());
      expect(reloaded.lastOpenedAt).not.toBe(before);
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for an unknown id (does not throw, creates nothing)", () => {
    expect(() => registry.touchProject("proj_does_not_exist")).not.toThrow();
    expect(registry.getById("proj_does_not_exist")).toBeNull();
  });
});
