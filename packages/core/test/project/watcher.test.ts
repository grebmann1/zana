// Tests for packages/core/src/project/watcher.ts
//
// The watcher module holds module-level state (watching flag, watcher Map,
// debounce timers). Tests use a real tmpdir so `fs.existsSync` calls succeed.
// When watched subdirectories don't exist, `createWatcher` returns early
// — no actual fs.watch() calls are made, keeping the suite deterministic.

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// CJS module — module.exports is surfaced as named exports under Vite ssr mode.
import * as watcher from "@zana-ai/core/src/project/watcher.ts";
const { start, stop, isWatching } = watcher as any;

/** Minimal fake Electron BrowserWindow — only the surface the watcher touches. */
function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: (_channel: string) => {} },
  };
}

const dirs: string[] = [];

function mktmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "zana-watcher-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  // Always reset watcher state between tests to avoid pollution.
  stop();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("project/watcher — start / stop / isWatching", () => {
  it("isWatching() is false before start() is called", () => {
    expect(isWatching()).toBe(false);
  });

  it("isWatching() returns true after start()", () => {
    const dir = mktmp();
    start(dir, fakeWindow());
    expect(isWatching()).toBe(true);
  });

  it("isWatching() returns false after stop()", () => {
    const dir = mktmp();
    start(dir, fakeWindow());
    stop();
    expect(isWatching()).toBe(false);
  });

  it("stop() before start() does not throw and leaves isWatching() false", () => {
    expect(() => stop()).not.toThrow();
    expect(isWatching()).toBe(false);
  });

  it("calling start() again while already watching stops the previous session first", () => {
    const dir1 = mktmp();
    const dir2 = mktmp();
    start(dir1, fakeWindow());
    expect(isWatching()).toBe(true);
    // Second start should implicitly stop the first and begin fresh.
    start(dir2, fakeWindow());
    expect(isWatching()).toBe(true);
  });

  it("stop() after stop() is idempotent and does not throw", () => {
    const dir = mktmp();
    start(dir, fakeWindow());
    stop();
    expect(() => stop()).not.toThrow();
    expect(isWatching()).toBe(false);
  });

  it("creates and closes real fs.FSWatcher for existing subdirectory", () => {
    const dir = mktmp();
    // Create one of the five watched subdirs so fs.watch() actually fires.
    fs.mkdirSync(path.join(dir, "tickets"));
    start(dir, fakeWindow());
    expect(isWatching()).toBe(true);
    // stop() should close the fs.FSWatcher without throwing.
    expect(() => stop()).not.toThrow();
    expect(isWatching()).toBe(false);
  });
});
