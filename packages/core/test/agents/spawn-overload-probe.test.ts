// Unit test for the spawn-overload PROBE itself
// (agents/__test-utils__/spawn-overload-probe.ts).
//
// Other suites (manager.test.ts, load-gate.test.ts) exercise the probe's
// op surface through the manager facade. What none of them assert is the
// probe's actual reason to exist: it must reach into the SAME shared streak
// state that lives in lifecycle.ts — not a private copy. This test imports
// the probe and lifecycle side-by-side and verifies mutations made through
// one are observable through the other (in both directions), plus the
// op-dispatch contract (clear → 0, unknown op → 0, limit → lifecycle value).
//
// Fully deterministic: no spawning, no PTY, no network.

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  _testSpawnOverloadProbe,
  _resetSpawnOverloadState,
} from "@zana-ai/core/src/agents/__test-utils__/spawn-overload-probe.ts";
import {
  spawnOverloadStreaks,
  recordSpawnOverload,
  getSpawnThrottleStreakLimit,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  // Point config at an empty tmp dir so getSpawnThrottleStreakLimit() reads
  // DEFAULTS (5) instead of requiring an uninitialized workspace-context.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-probe-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  _resetSpawnOverloadState();
});

describe("spawn-overload-probe shared-state invariant", () => {
  it("probe 'record' mutates lifecycle's shared streak map", () => {
    _testSpawnOverloadProbe("record", "parent-A");
    expect(spawnOverloadStreaks.get("parent-A")).toBe(1);
  });

  it("lifecycle.recordSpawnOverload is observable through the probe (shared map, both directions)", () => {
    recordSpawnOverload("parent-B");
    // Probe continues the SAME streak rather than starting a fresh one.
    expect(_testSpawnOverloadProbe("record", "parent-B")).toBe(2);
  });

  it("_resetSpawnOverloadState clears the lifecycle map", () => {
    recordSpawnOverload("parent-C");
    _resetSpawnOverloadState();
    expect(spawnOverloadStreaks.has("parent-C")).toBe(false);
  });

  it("probe 'clear' removes the entry and returns 0", () => {
    _testSpawnOverloadProbe("record", "parent-D");
    expect(_testSpawnOverloadProbe("clear", "parent-D")).toBe(0);
    expect(spawnOverloadStreaks.has("parent-D")).toBe(false);
  });

  it("probe 'limit' delegates to lifecycle.getSpawnThrottleStreakLimit", () => {
    expect(_testSpawnOverloadProbe("limit")).toBe(getSpawnThrottleStreakLimit());
  });

  it("an unrecognized op is a safe no-op returning 0", () => {
    expect(_testSpawnOverloadProbe("bogus" as any, "parent-E")).toBe(0);
    expect(spawnOverloadStreaks.has("parent-E")).toBe(false);
  });
});
