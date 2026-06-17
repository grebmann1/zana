// Unit tests for the config-persistence surface of
// packages/core/src/events/store.ts
//
// Covers behaviour the existing store.test.ts leaves untested:
//   - saveConfig → loadConfig round-trip (happy path)
//   - loadConfig returns DEFAULT_CONFIG when no config file exists
//   - loadConfig merges a partial on-disk config over the defaults
//   - loadConfig falls back to defaults on malformed JSON
//   - ensureDir / saveConfig honour the tenant-isolation write gate
//     (refuse to write when no workspace is initialized)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/core/src/events/store.ts";

// Both the .ts source and the compiled dist export the same workspaceContext
// singleton; reset both to avoid cross-test bleed.
const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  workspaceContextTs.init(root);
  wcDist.init(root);
}

const DEFAULT_CONFIG = {
  retentionCount: 5000,
  retentionMs: 86400000,
  persistToDisk: true,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-store-config-test-"));
  // Pre-create .zana/ so resolveProjectDir anchors here instead of walking
  // up to any ancestor .zana/ directory (e.g. /tmp/.zana on macOS).
  fs.mkdirSync(path.join(tmpDir, ".zana"), { recursive: true });
  initWorkspace(tmpDir);
});

afterEach(() => {
  resetWorkspace();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("store — loadConfig defaults", () => {
  it("returns DEFAULT_CONFIG when no config file exists", () => {
    expect(store.loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});

describe("store — saveConfig / loadConfig round-trip", () => {
  it("loadConfig returns exactly what saveConfig persisted", () => {
    const config = { retentionCount: 10, retentionMs: 1234, persistToDisk: false };
    store.saveConfig(config);
    expect(store.loadConfig()).toEqual(config);
  });

  it("loadConfig merges a partial on-disk config over the defaults", () => {
    // Persist only one field; the rest must fall back to DEFAULT_CONFIG.
    store.saveConfig({ retentionCount: 42 });
    expect(store.loadConfig()).toEqual({ ...DEFAULT_CONFIG, retentionCount: 42 });
  });

  it("falls back to defaults when the config file is malformed JSON", () => {
    store.ensureDir();
    const configFile = path.join(tmpDir, ".zana", "events", "bus-config.json");
    fs.writeFileSync(configFile, "{ not valid json", "utf8");
    expect(store.loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});

describe("store — tenant-isolation write gate", () => {
  it("ensureDir throws when no workspace is initialized", () => {
    resetWorkspace();
    expect(() => store.ensureDir()).toThrow();
  });

  it("saveConfig refuses to write when no workspace is initialized", () => {
    resetWorkspace();
    expect(() => store.saveConfig({ retentionCount: 1 })).toThrow();
  });
});
