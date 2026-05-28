import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Mock os.loadavg(), freemem(), totalmem() so tests can simulate any
// load without thrashing the real box and without false-positive
// memory failures on a real machine that happens to be near full.
// Module-level vi.mock is hoisted; assign __mock* before each test that
// needs non-default values.
let __mockLoad = 0.1;
let __mockFree = 8 * 1024 * 1024 * 1024; // 8 GiB
let __mockTotal = 16 * 1024 * 1024 * 1024; // 16 GiB (50% free, well above 10%)
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof os>("node:os");
  return {
    ...actual,
    loadavg: () => [__mockLoad, __mockLoad, __mockLoad],
    freemem: () => __mockFree,
    totalmem: () => __mockTotal,
  };
});

import {
  checkSystemResources,
  _resetSpawnOverloadState,
  _testSpawnOverloadProbe,
} from "@zana/core/src/agents/manager.ts";
import * as moduleConfig from "@zana/core/src/modules/config.ts";

beforeAll(() => {
  // Point module-config at a tmp file so it doesn't try to read a
  // non-existent workspace dir during unit-test load.
  const tmp = mkdtempSync(path.join(tmpdir(), "zana-load-gate-"));
  moduleConfig.setConfigPath(path.join(tmp, "config.json"));
});

function setLoad(value: number) {
  __mockLoad = value;
}

function restoreLoad() {
  __mockLoad = 0.1;
}

describe("checkSystemResources", () => {
  afterEach(() => {
    restoreLoad();
  });

  it("returns null when load is well below soft threshold", () => {
    setLoad(0.1);
    expect(checkSystemResources()).toBeNull();
    expect(checkSystemResources("soft")).toBeNull();
    expect(checkSystemResources("hard")).toBeNull();
  });

  it("soft fails when load exceeds cores * 0.8 but not cores * 2.0", () => {
    const cores = os.cpus().length;
    setLoad(cores * 1.2); // above soft (0.8x), below hard (2.0x)
    const soft = checkSystemResources("soft");
    const hard = checkSystemResources("hard");
    expect(soft).toMatch(/CPU load too high/);
    expect(soft).toMatch(/soft threshold/);
    expect(hard).toBeNull();
  });

  it("hard fails when load exceeds cores * 2.0", () => {
    const cores = os.cpus().length;
    setLoad(cores * 3); // above hard cap
    const hard = checkSystemResources("hard");
    expect(hard).toMatch(/CPU load too high/);
    expect(hard).toMatch(/hard threshold/);
  });

  it("default (no severity arg) is soft", () => {
    const cores = os.cpus().length;
    setLoad(cores * 1.2);
    expect(checkSystemResources()).toMatch(/soft threshold/);
  });
});

/**
 * Streak-counter logic. We test the counter directly via _testSpawnOverloadProbe
 * (a thin test-only export that exercises recordSpawnOverload + clearSpawnOverloadStreak)
 * instead of routing through handleOrchestratorCommand, which dynamically requires
 * many modules that aren't initialized in this unit-test scope.
 */
describe("spawn overload streak counter", () => {
  beforeEach(() => {
    _resetSpawnOverloadState();
  });

  afterEach(() => {
    _resetSpawnOverloadState();
  });

  it("counts consecutive throttle hits per parent", () => {
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(1);
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(2);
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(3);
  });

  it("counters are independent across parents", () => {
    _testSpawnOverloadProbe("record", "parent-A");
    _testSpawnOverloadProbe("record", "parent-A");
    expect(_testSpawnOverloadProbe("record", "parent-B")).toBe(1);
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(3);
  });

  it("clear resets the counter for that parent only", () => {
    _testSpawnOverloadProbe("record", "parent-A");
    _testSpawnOverloadProbe("record", "parent-A");
    _testSpawnOverloadProbe("record", "parent-B");
    _testSpawnOverloadProbe("clear", "parent-A");
    expect(_testSpawnOverloadProbe("record", "parent-A")).toBe(1);
    // parent-B unaffected
    expect(_testSpawnOverloadProbe("record", "parent-B")).toBe(2);
  });

  it("null/undefined parent shares a single bucket", () => {
    expect(_testSpawnOverloadProbe("record", null)).toBe(1);
    expect(_testSpawnOverloadProbe("record", undefined)).toBe(2);
    expect(_testSpawnOverloadProbe("record", "")).toBe(3);
  });

  it("getStreakLimit returns the configured value (default 5)", () => {
    expect(_testSpawnOverloadProbe("limit")).toBe(5);
  });
});
