// loader — init() / shutdown() lifecycle when no modules are discovered.
//
// The sibling loader.test.ts deliberately never calls init()/shutdown() (it
// pins only the read-only, pre-init query surface). This file covers the
// complementary path: the init → shutdown lifecycle itself.
//
// In the vitest *source* context, the loader's MODULES_DIR resolves to
// packages/core/src/modules/, which contains only .ts files (no module
// sub-directories with a module.json). So discoverModules() returns [] and
// init() takes its `discovered.length === 0` early-return branch — it marks
// itself initialized without touching the workspace lock or starting the
// config watcher.
//
// Determinism: we point moduleConfig at a non-existent config path so load()
// falls back to DEFAULTS (no workspace-context init, no fs writes, no timers).
// Each test file gets a fresh loader module instance under vitest, so the
// module-level `initialized` flag starts false here regardless of other files.
//
// Scope note: we intentionally do NOT call shutdown() here. shutdown()
// unconditionally calls removeLock() → getLockPath(), which does a dynamic
// require("../project/workspace-context") that Node cannot resolve as a .ts
// module in this vitest source context. That post-init teardown path is not
// deterministically exercisable from src and is out of scope for this file.

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

import * as loader from "../../src/modules/loader.ts";
import * as moduleConfig from "../../src/modules/config.ts";

beforeAll(() => {
  // Decouple from workspace-context: a missing file makes load() use DEFAULTS.
  moduleConfig.setConfigPath(
    path.join(os.tmpdir(), "zana-loader-init-empty-nonexistent-config.json"),
  );
});

describe("loader init() lifecycle with zero discovered modules", () => {
  it("init() resolves and loads no modules when none are on disk", async () => {
    await expect(loader.init()).resolves.toBeUndefined();
    expect(loader.listModules()).toEqual([]);
  });

  it("init() is idempotent — a second call is a no-op that still resolves", async () => {
    await expect(loader.init()).resolves.toBeUndefined();
    expect(loader.listModules()).toEqual([]);
  });

  it("getModule() still returns null after a zero-module init()", () => {
    expect(loader.getModule("any-id-never-registered")).toBeNull();
  });
});
