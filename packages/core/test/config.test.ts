import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Import config once — the deprecated getters are lazy (re-evaluate each
// access via ctx.isInitialized()), so no need to re-require after resets.
import config from "@zana-ai/core/src/config.ts";
import * as ctx from "@zana-ai/core/src/project/workspace-context.ts";

describe("config — static constants and global paths", () => {
  it("ZANA_DIR is ~/.zana", () => {
    expect(config.ZANA_DIR).toBe(path.join(os.homedir(), ".zana"));
  });

  it("global sub-dirs are all direct children of ZANA_DIR", () => {
    for (const key of ["PROFILES_DIR", "TEAMS_DIR", "SKILLS_DIR", "PLUGINS_DIR", "DAEMONS_DIR", "BIN_DIR"] as const) {
      expect(path.dirname((config as any)[key])).toBe(config.ZANA_DIR);
    }
  });

  it("SETTINGS_PATH is ZANA_DIR/settings.json", () => {
    expect(config.SETTINGS_PATH).toBe(path.join(config.ZANA_DIR, "settings.json"));
  });

  it("DEFAULT_HOOK_PORT is a positive integer", () => {
    expect(Number.isInteger(config.DEFAULT_HOOK_PORT)).toBe(true);
    expect(config.DEFAULT_HOOK_PORT).toBeGreaterThan(0);
  });

  it("MAX_CONCURRENT_AGENTS is a positive integer", () => {
    expect(Number.isInteger(config.MAX_CONCURRENT_AGENTS)).toBe(true);
    expect(config.MAX_CONCURRENT_AGENTS).toBeGreaterThan(0);
  });
});

describe("config — deprecated getters (workspace not initialized)", () => {
  beforeEach(() => ctx._resetForTesting());
  afterEach(() => ctx._resetForTesting());

  it("TICKETS_DIR falls back to ~/.zana/tickets", () => {
    expect((config as any).TICKETS_DIR).toBe(path.join(os.homedir(), ".zana", "tickets"));
  });

  it("SPRINTS_DIR falls back to ~/.zana/sprints", () => {
    expect((config as any).SPRINTS_DIR).toBe(path.join(os.homedir(), ".zana", "sprints"));
  });

  it("ARTIFACTS_DIR falls back to ~/.zana/artifacts", () => {
    expect((config as any).ARTIFACTS_DIR).toBe(path.join(os.homedir(), ".zana", "artifacts"));
  });

  it("RUNS_DIR falls back to ~/.zana/runs", () => {
    expect((config as any).RUNS_DIR).toBe(path.join(os.homedir(), ".zana", "runs"));
  });

  it("SCHEDULER_DIR falls back to ~/.zana/scheduler", () => {
    expect((config as any).SCHEDULER_DIR).toBe(path.join(os.homedir(), ".zana", "scheduler"));
  });

  it("TMP_DIR falls back to ~/.zana/tmp", () => {
    expect((config as any).TMP_DIR).toBe(path.join(os.homedir(), ".zana", "tmp"));
  });
});

describe("config — deprecated getters (workspace initialized)", () => {
  const fakeRoot = "/tmp/fake-workspace-for-config-test";

  beforeEach(() => {
    ctx._resetForTesting();
    ctx.init(fakeRoot);
  });
  afterEach(() => ctx._resetForTesting());

  it("TICKETS_DIR is no longer the global fallback when workspace is initialized", () => {
    expect((config as any).TICKETS_DIR).not.toBe(path.join(os.homedir(), ".zana", "tickets"));
  });

  it("TICKETS_DIR still contains 'tickets' in its path", () => {
    expect((config as any).TICKETS_DIR).toContain("tickets");
  });

  it("RUNS_DIR is no longer the global fallback when workspace is initialized", () => {
    expect((config as any).RUNS_DIR).not.toBe(path.join(os.homedir(), ".zana", "runs"));
  });

  it("SCHEDULER_DIR is no longer the global fallback when workspace is initialized", () => {
    expect((config as any).SCHEDULER_DIR).not.toBe(path.join(os.homedir(), ".zana", "scheduler"));
  });
});
