// modules/config — covers the polling file-watcher, untested by config.test.ts:
//   - startWatching() polls the config file and fires onConfigChanged()
//     listeners with (newConfig, oldConfig) when the on-disk content changes
//   - an unchanged file (same hash) does NOT fire listeners
//   - stopWatching() halts polling and clears registered listeners
//   - startWatcher/stopWatcher are exported aliases of the canonical fns
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
  tmpDir = mkdtempSync(join(tmpdir(), "zana-config-watcher-test-"));
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

describe("config watcher", () => {
  it("fires onConfigChanged with (newConfig, oldConfig) when the file changes on disk", () => {
    vi.useFakeTimers();
    const calls: Array<[any, any]> = [];
    cfg.onConfigChanged((newCfg, oldCfg) => calls.push([newCfg, oldCfg]));
    cfg.startWatching();

    writeFileSync(cfgPath, JSON.stringify({ modules: { alpha: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(2000);

    expect(calls).toHaveLength(1);
    const [newCfg, oldCfg] = calls[0];
    expect(newCfg.modules.alpha.enabled).toBe(false); // parsed new content
    expect(oldCfg.modules).toEqual({}); // prior in-memory state
    expect(cfg.get().modules.alpha.enabled).toBe(false); // currentConfig updated
  });

  it("does NOT fire listeners when the polled file content is unchanged", () => {
    vi.useFakeTimers();
    const payload = JSON.stringify({ modules: { beta: { enabled: true } } });
    writeFileSync(cfgPath, payload, "utf8");
    cfg.load(); // adopt this content as the current hash baseline

    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();

    vi.advanceTimersByTime(2000); // same bytes → same hash → no notification
    expect(listener).not.toHaveBeenCalled();
  });

  it("stopWatching() halts polling and clears listeners so later changes are ignored", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    cfg.onConfigChanged(listener);
    cfg.startWatching();
    cfg.stopWatching();

    writeFileSync(cfgPath, JSON.stringify({ modules: { gamma: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(4000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("startWatcher/stopWatcher are aliases of startWatching/stopWatching", () => {
    expect(cfg.startWatcher).toBe(cfg.startWatching);
    expect(cfg.stopWatcher).toBe(cfg.stopWatching);
  });

  // onConfigChanged() returns an unsubscribe disposer. The other tests only
  // register listeners; none exercise the returned function. This pins the
  // contract: calling the disposer removes ONLY that listener, so a later
  // on-disk change no longer fires it while other listeners still run.
  it("the disposer returned by onConfigChanged() unsubscribes only that listener", () => {
    vi.useFakeTimers();
    const kept = vi.fn();
    const removed = vi.fn();
    cfg.onConfigChanged(kept);
    const dispose = cfg.onConfigChanged(removed);
    cfg.startWatching();

    dispose(); // unsubscribe `removed` before any change is polled

    writeFileSync(cfgPath, JSON.stringify({ modules: { delta: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(2000);

    expect(removed).not.toHaveBeenCalled(); // disposed listener stays silent
    expect(kept).toHaveBeenCalledTimes(1); // surviving listener still fires
  });

  // startWatching() guards against double-start with `if (pollTimer) return`, so
  // a second call is a no-op rather than spawning a second setInterval. Without
  // that guard the second start would overwrite `pollTimer`, orphaning the first
  // interval — a leaked poller that stopWatching() can never clear and that keeps
  // mutating `currentConfig` after the watcher is supposed to be stopped. This
  // pins idempotency: after start→start→stop, a later on-disk change is NOT
  // observed (currentConfig stays put), proving exactly one cancellable timer
  // existed. The existing suite only ever starts the watcher once.
  it("startWatching() is idempotent: a single stop fully halts even after a double start", () => {
    vi.useFakeTimers();
    cfg.startWatching();
    cfg.startWatching(); // must be a no-op (guarded), not a second leaked interval
    cfg.stopWatching(); // one stop must cancel the one and only timer

    // A leaked second interval would still be polling and would pick this up.
    writeFileSync(cfgPath, JSON.stringify({ modules: { zeta: { enabled: false } } }), "utf8");
    vi.advanceTimersByTime(4000);

    // Fully stopped: the on-disk change is never observed in memory.
    expect(cfg.get().modules).toEqual({});
  });

  // startWatching() wraps each listener in try/catch: a throwing listener must
  // not abort the notification loop, and the error is reported to stderr rather
  // than propagated. This pins that resilience invariant — a single buggy
  // listener cannot silence the others or crash the poll cycle.
  it("isolates a throwing listener: others still fire and the error is logged to stderr", () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const boom = vi.fn(() => {
      throw new Error("listener kaboom");
    });
    const after = vi.fn();
    cfg.onConfigChanged(boom); // registered first so it throws mid-loop
    cfg.onConfigChanged(after); // must still run despite the prior throw
    cfg.startWatching();

    writeFileSync(cfgPath, JSON.stringify({ modules: { eps: { enabled: false } } }), "utf8");
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow(); // poll survives

    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1); // not short-circuited by the throw
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("listener kaboom"),
    );
    stderrSpy.mockRestore();
  });
});
