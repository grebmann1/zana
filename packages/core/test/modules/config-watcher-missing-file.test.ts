// modules/config — the polling watcher's resilience to the config file
// vanishing mid-watch.
//
// startWatching()'s poll cycle wraps fs.readFileSync in its OWN try/catch
// (config.ts lines 112-114), SEPARATE from the JSON.parse guard exercised by
// config-watcher-malformed-json.test.ts. When the file is deleted (or becomes
// unreadable) between polls the read throws ENOENT and the cycle `return`s
// early: it must NOT throw, must NOT fire onConfigChanged listeners, and must
// leave currentConfig at its last good value. The existing watcher suites only
// ever poll an existing file (they write before advancing the timer), so this
// read-error branch is otherwise untested.
//
// Deterministic: vitest fake timers drive the 2000ms poll; fs writes/deletes
// are local to a tmp dir. No real time, network, or shared global state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as cfg from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zana-config-watcher-missing-"));
  cfgPath = join(tmpDir, "config.json");
  cfg.setConfigPath(cfgPath);
  cfg.stopWatching();
  // Seed a valid baseline so currentConfig holds a known good value.
  writeFileSync(cfgPath, JSON.stringify({ modules: { seed: { enabled: true } } }), "utf8");
  cfg.load();
});

afterEach(() => {
  cfg.stopWatching();
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("config watcher — file removed at poll time", () => {
  it("ignores a deleted file: no throw, no listener fire, currentConfig preserved", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();

    // The config file disappears between polls (readFileSync will throw ENOENT).
    rmSync(cfgPath, { force: true });

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow(); // read error swallowed
    expect(listener).not.toHaveBeenCalled(); // a missing file never notifies
    expect(cfg.get().modules.seed.enabled).toBe(true); // last good state preserved
  });

  it("resumes firing once the file reappears after a missing poll", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();

    rmSync(cfgPath, { force: true });
    vi.advanceTimersByTime(2000); // missing poll: skipped, no fire
    expect(listener).not.toHaveBeenCalled();

    writeFileSync(cfgPath, JSON.stringify({ modules: { back: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(2000); // file restored: now fires

    expect(listener).toHaveBeenCalledTimes(1);
    expect(cfg.get().modules.back.enabled).toBe(false);
  });
});
