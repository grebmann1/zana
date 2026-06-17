// modules/config — the polling watcher's resilience to a corrupt file on disk.
//
// startWatching()'s poll cycle has its OWN try/catch around JSON.parse
// (config.ts lines 116-118), separate from load()'s fallback. When the config
// file is half-written or corrupted at poll time the parse fails and the cycle
// `return`s early: it must NOT throw, must NOT fire onConfigChanged listeners,
// and must leave currentConfig at its last good value. config-watcher.test.ts
// only ever writes valid JSON, and config-load-malformed-json.test.ts exercises
// load() — not the watcher — so this poll-time branch is otherwise untested.
//
// Deterministic: vitest fake timers drive the 2000ms poll; fs writes are local
// to a tmp dir. No real time, network, or shared global state across tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as cfg from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zana-config-watcher-malformed-"));
  cfgPath = join(tmpDir, "config.json");
  cfg.setConfigPath(cfgPath);
  cfg.stopWatching();
  cfg.load(); // seed in-memory state + lastHash from the (missing) file
});

afterEach(() => {
  cfg.stopWatching();
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("config watcher — malformed JSON at poll time", () => {
  it("ignores a corrupt file: no throw, no listener fire, currentConfig unchanged", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();

    // A half-written / corrupt config appears between polls.
    writeFileSync(cfgPath, "{ not: valid json", "utf8");

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow(); // parse error swallowed
    expect(listener).not.toHaveBeenCalled(); // unparseable content never notifies
    expect(cfg.get().modules).toEqual({}); // last good in-memory state preserved
  });

  it("recovers once the file becomes valid again after a corrupt poll", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();

    writeFileSync(cfgPath, "}{ broken", "utf8");
    vi.advanceTimersByTime(2000); // corrupt poll: skipped, no fire
    expect(listener).not.toHaveBeenCalled();

    writeFileSync(cfgPath, JSON.stringify({ modules: { ok: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(2000); // valid poll: now fires

    expect(listener).toHaveBeenCalledTimes(1);
    expect(cfg.get().modules.ok.enabled).toBe(false);
  });
});
