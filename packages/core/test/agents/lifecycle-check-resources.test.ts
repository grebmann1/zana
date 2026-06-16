// Unit tests for checkSystemResources() in agents/lifecycle.ts.
//
// Strategy: vi.mock node:os so we can control loadavg / cpus counts without
// touching real system state. moduleConfig is pointed at an empty tmp dir so
// the default thresholds (cpuLoadThreshold=0.8, cpuLoadHardCap=2.0) come from
// the in-memory DEFAULTS and no real workspace init is required.
//
// No real spawning, no real PTY, no network — fully deterministic.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as osReal from "node:os";

// ---------------------------------------------------------------------------
// Mutable slots the vi.mock factory reads at call time.
// ---------------------------------------------------------------------------
let _mockLoad1m = 0;
let _mockCpuCount = 4;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    loadavg: () => [_mockLoad1m, 0, 0],
    cpus: () => Array.from({ length: _mockCpuCount }, () => ({} as osReal.CpuInfo)),
  };
});

// ---------------------------------------------------------------------------
// Now safe to import production code — it will pick up the mocked os module.
// ---------------------------------------------------------------------------
import { checkSystemResources } from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(osReal.tmpdir(), "zana-lifecycle-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
  // No config file → `load()` falls back to DEFAULTS: soft=0.8, hard=2.0
});

beforeEach(() => {
  // The CPU gate is OFF by default (system.cpuGateEnabled=false). The threshold
  // tests below exercise the loadavg math, so opt the gate in explicitly. A
  // test can override this with its own save() to assert the default-off path.
  moduleConfig.save({ modules: {}, system: { cpuGateEnabled: true } } as any);
});

afterEach(() => {
  // Reset mock slots to safe defaults.
  _mockLoad1m = 0;
  _mockCpuCount = 4;
  // Force moduleConfig to re-read from disk (the file may not exist → DEFAULTS).
  (moduleConfig as any).currentConfig = null;
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

// Helper: control OS readings for one test.
function stubOs(load1m: number, cpuCount: number) {
  _mockLoad1m = load1m;
  _mockCpuCount = cpuCount;
}

// ---------------------------------------------------------------------------
describe("checkSystemResources — soft severity (default)", () => {
  it("returns null when 1-min load is well below soft threshold", () => {
    // 4 cores × 0.8 = 3.2; actual load = 1.0 → ok
    stubOs(1.0, 4);
    expect(checkSystemResources()).toBeNull();
  });

  it("returns null when load exactly equals the threshold (not strictly greater)", () => {
    // 4 cores × 0.8 = 3.2; load = 3.2 → not triggered (> not >=)
    stubOs(3.2, 4);
    expect(checkSystemResources()).toBeNull();
  });

  it("returns an error string when load exceeds the soft threshold", () => {
    // 4 cores × 0.8 = 3.2; load = 4.0 → overloaded
    stubOs(4.0, 4);
    const result = checkSystemResources("soft");
    expect(typeof result).toBe("string");
    expect(result).toMatch(/CPU load too high/);
    expect(result).toMatch(/4\.00/);   // load1m formatted to 2dp
    expect(result).toMatch(/soft/);    // severity label present
    expect(result).toMatch(/4 cores/); // cpu count present
  });

  it("error string includes the formatted max-load value (cpuCount × factor)", () => {
    // 2 cores × 0.8 = 1.6; load = 2.0
    stubOs(2.0, 2);
    const result = checkSystemResources();
    expect(result).toMatch(/1\.60/);   // max threshold value
    expect(result).toMatch(/80%/);     // human-readable % factor
  });

  it("scales ceiling with cpu count — more cores raise the allowed maximum", () => {
    // 8 cores × 0.8 = 6.4; load = 6.0 → still ok
    stubOs(6.0, 8);
    expect(checkSystemResources()).toBeNull();

    // Same load on 4 cores: 4 × 0.8 = 3.2 → overloaded
    stubOs(6.0, 4);
    expect(checkSystemResources()).not.toBeNull();
  });
});

describe("checkSystemResources — hard severity", () => {
  it("returns null at a load that fails soft but passes hard (cap 2.0×)", () => {
    // 4 cores × soft=0.8 = 3.2 → would fail soft; 4 × hard=2.0 = 8.0 → ok
    stubOs(4.0, 4);
    expect(checkSystemResources("hard")).toBeNull();
  });

  it("returns an error string when load exceeds the hard cap", () => {
    // 4 cores × 2.0 = 8.0; load = 9.0 → overloaded (hard)
    stubOs(9.0, 4);
    const result = checkSystemResources("hard");
    expect(typeof result).toBe("string");
    expect(result).toMatch(/CPU load too high/);
    expect(result).toMatch(/hard/);
  });
});

describe("checkSystemResources — custom thresholds from config", () => {
  it("respects a lower cpuLoadThreshold, triggering even at modest load", () => {
    // Very low threshold: 4 cores × 0.1 = 0.4; load = 0.5 → overloaded
    moduleConfig.save({
      modules: {},
      system: { cpuGateEnabled: true, cpuLoadThreshold: 0.1, cpuLoadHardCap: 2.0 },
    } as any);
    stubOs(0.5, 4);
    const result = checkSystemResources("soft");
    expect(result).not.toBeNull();
    expect(result).toMatch(/CPU load too high/);
  });

  it("respects a higher cpuLoadThreshold, staying ok under the default limit", () => {
    // Default 0.8 → 4 cores = 3.2; load = 4.0 would fail under defaults.
    // Raise threshold to 1.5 → 4 × 1.5 = 6.0; load = 4.0 should now pass.
    moduleConfig.save({
      modules: {},
      system: { cpuGateEnabled: true, cpuLoadThreshold: 1.5, cpuLoadHardCap: 3.0 },
    } as any);
    stubOs(4.0, 4);
    expect(checkSystemResources("soft")).toBeNull();
  });
});

describe("checkSystemResources — gate disabled (default)", () => {
  // Pins the new default: with cpuGateEnabled absent/false the gate is a no-op
  // regardless of load, so a future change can't silently re-arm it.
  it("returns null at crushing load when the gate key is absent", () => {
    moduleConfig.save({ modules: {}, system: { cpuLoadThreshold: 0.8 } } as any);
    stubOs(100, 4); // far above any soft/hard threshold
    expect(checkSystemResources("soft")).toBeNull();
    expect(checkSystemResources("hard")).toBeNull();
  });

  it("returns null at crushing load when cpuGateEnabled is explicitly false", () => {
    moduleConfig.save({ modules: {}, system: { cpuGateEnabled: false } } as any);
    stubOs(100, 4);
    expect(checkSystemResources("soft")).toBeNull();
    expect(checkSystemResources("hard")).toBeNull();
  });
});
