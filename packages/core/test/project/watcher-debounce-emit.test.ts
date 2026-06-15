// project/watcher — the change-detection behavior that is the module's whole
// reason to exist: a relevant file change inside a watched subdir must, after
// the DEBOUNCE_MS window, push the mapped IPC channel to the renderer; ignored
// files (dot- or underscore-prefixed, or a null filename) must NOT; and a burst
// of rapid changes must coalesce into a single emit.
//
// The sibling watcher.test.ts deliberately never lets fs.watch() fire (it pins
// only start/stop/isWatching state) "to keep the suite deterministic". This file
// covers the complementary path deterministically WITHOUT real IO or real time:
// fs.existsSync/fs.watch are spied on the shared node:fs object (the same object
// watcher.ts captured via require('fs')), so start() hands us the change
// callback, and fake timers drive the debounce. No tmpdirs, no real watchers,
// no wall-clock waits.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import { createRequire } from "node:module";

import * as watcher from "@zana-ai/core/src/project/watcher.ts";
const { start, stop } = watcher as any;

// watcher.ts captures `const fs = require('fs')` at load time. Grab that SAME
// mutable CJS module object here so overriding its methods is visible to the
// SUT (the ESM `import * as fs` namespace is frozen and cannot be spied).
const fs: any = createRequire(import.meta.url)("fs");
const realExistsSync = fs.existsSync;
const realWatch = fs.watch;

type WatchCb = (eventType: string, filename: string | null) => void;
let watchCalls: { path: string; cb: WatchCb }[] = [];

function fakeWindow() {
  const sent: string[] = [];
  return { sent, isDestroyed: () => false, webContents: { send: (c: string) => sent.push(c) } };
}

/** Resolve the change-callback fs.watch() received for a given watched subdir. */
function cbFor(subdir: string): WatchCb {
  const hit = watchCalls.find((w) => w.path.endsWith(path.sep + subdir) || w.path.endsWith("/" + subdir));
  if (!hit) throw new Error(`no fs.watch() registered for subdir "${subdir}"`);
  return hit.cb;
}

beforeEach(() => {
  watchCalls = [];
  vi.useFakeTimers();
  // Override the shared fs object watcher.ts holds via require('fs').
  //   existsSync → true: every watched subdir "exists" so createWatcher proceeds.
  //   watch      → capture the change callback + return a minimal FSWatcher.
  fs.existsSync = () => true;
  fs.watch = (p: any, _opts: any, cb: WatchCb) => {
    watchCalls.push({ path: String(p), cb });
    return { on: () => {}, close: () => {} };
  };
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  fs.existsSync = realExistsSync;
  fs.watch = realWatch;
});

describe("project/watcher — debounced change emit", () => {
  it("emits the mapped channel after DEBOUNCE_MS when a relevant file changes", () => {
    const win = fakeWindow();
    start("/proj", win);

    cbFor("tickets")("change", "TICKET-1.json");
    // Debounced: nothing fires synchronously.
    expect(win.sent).toEqual([]);

    vi.advanceTimersByTime(80); // DEBOUNCE_MS
    expect(win.sent).toEqual(["project:tickets-changed"]);
  });

  it("ignores dot-, underscore-prefixed, and null filenames (no emit)", () => {
    const win = fakeWindow();
    start("/proj", win);

    const cb = cbFor("sprints");
    cb("change", ".hidden");
    cb("rename", "_index.json");
    cb("change", null);

    vi.advanceTimersByTime(200);
    expect(win.sent).toEqual([]);
  });

  it("coalesces a burst of rapid changes into a single emit", () => {
    const win = fakeWindow();
    start("/proj", win);

    const cb = cbFor("artifacts");
    cb("change", "a.json");
    cb("change", "b.json");
    cb("change", "c.json");

    vi.advanceTimersByTime(80);
    expect(win.sent).toEqual(["project:artifacts-changed"]);
  });
});
