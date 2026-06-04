import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import config from "@zana-ai/core/src/config.ts";

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

  it("PERSIST_DIR and SCRATCHPAD_DIR are still children of ZANA_DIR", () => {
    expect(path.dirname((config as any).PERSIST_DIR)).toBe(config.ZANA_DIR);
    expect(path.dirname((config as any).SCRATCHPAD_DIR)).toBe(config.ZANA_DIR);
  });
});

describe("config — deprecated project-local getters are gone", () => {
  // These names used to be `get` accessors that proxied to
  // workspaceContext.getProjectPaths(). They have been removed; call sites
  // must now use `core.project.workspaceContext.getProjectPaths().<X>`
  // directly. This test prevents regression — silently re-adding the proxy
  // would re-introduce the cross-tenant fallback to ~/.zana/.
  for (const key of [
    "TICKETS_DIR",
    "SPRINTS_DIR",
    "ARTIFACTS_DIR",
    "SESSIONS_DIR",
    "EVENTS_DIR",
    "RUNS_DIR",
    "SCHEDULER_DIR",
    "TMP_DIR",
  ]) {
    it(`config.${key} is no longer exported`, () => {
      expect((config as any)[key]).toBeUndefined();
    });
  }
});
