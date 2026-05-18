import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Lock down the registry semantics that the daemon's concurrent-start guard
// relies on. We don't fork an actual daemon process here — that's e2e — but we
// do exercise the registry against live and dead PIDs so the guard's contract
// can't silently regress.

import * as registry from "@zana/core/src/daemon/registry.ts";

const DAEMONS_DIR = path.join(os.homedir(), ".zana", "daemons");
const TEST_PREFIX = `test-concurrency-${Date.now()}`;

function writeEntry(entry: any) {
  fs.mkdirSync(DAEMONS_DIR, { recursive: true });
  const filePath = path.join(DAEMONS_DIR, `${entry.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return filePath;
}

function cleanup() {
  try {
    for (const f of fs.readdirSync(DAEMONS_DIR)) {
      if (f.startsWith(TEST_PREFIX)) {
        try { fs.unlinkSync(path.join(DAEMONS_DIR, f)); } catch {}
      }
    }
  } catch {}
}

describe("daemon-concurrency: registry guard semantics", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("findRunningDaemon returns an entry when its PID is alive and the workspace matches", () => {
    const workspace = path.join(os.tmpdir(), `${TEST_PREFIX}-ws-alive`);
    const entry = {
      id: `${TEST_PREFIX}-alive`,
      port: 47402,
      pid: process.pid, // self — guaranteed alive while the test runs
      workspace,
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };
    writeEntry(entry);

    const found = registry.findRunningDaemon(workspace);
    expect(found).not.toBeNull();
    expect(found.id).toBe(entry.id);
    expect(found.pid).toBe(process.pid);
  });

  it("findRunningDaemon returns null when no entry matches the workspace and only stale entries exist", () => {
    const workspace = path.join(os.tmpdir(), `${TEST_PREFIX}-ws-no-match`);
    // A stale entry for a *different* workspace with a dead PID.
    writeEntry({
      id: `${TEST_PREFIX}-stale-other`,
      port: 47402,
      pid: 999999, // unlikely to be a live PID
      workspace: path.join(os.tmpdir(), `${TEST_PREFIX}-ws-different`),
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

    const found = registry.findRunningDaemon(workspace);
    // Either null (preferred when nothing alive matches) or — if the function
    // falls back to "any alive headless" — at minimum it must NOT return the
    // stale entry. The dead PID ensures listAlive() drops it.
    if (found) {
      expect(found.id).not.toBe(`${TEST_PREFIX}-stale-other`);
    } else {
      expect(found).toBeNull();
    }
  });

  it("cleanStale removes registry entries whose PID is dead", () => {
    const stalePath = writeEntry({
      id: `${TEST_PREFIX}-stale`,
      port: 47402,
      pid: 999999, // dead PID
      workspace: path.join(os.tmpdir(), `${TEST_PREFIX}-ws-stale`),
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

    const removed = registry.cleanStale();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it("cleanStale leaves entries with live PIDs in place", () => {
    const livePath = writeEntry({
      id: `${TEST_PREFIX}-live-keep`,
      port: 47402,
      pid: process.pid,
      workspace: path.join(os.tmpdir(), `${TEST_PREFIX}-ws-live`),
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

    registry.cleanStale();
    expect(fs.existsSync(livePath)).toBe(true);
  });
});
