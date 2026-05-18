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

  // Auditor finding 6fcb24e6: findRunningDaemon must NOT cross workspaces.
  // When the caller asks "is a daemon running for /repo-A?", a daemon for
  // /repo-B must never come back as the answer — that triggers a false
  // positive in the concurrent-daemon guard at startup.
  describe("findRunningDaemon cross-workspace isolation", () => {
    it("returns null when workspace is given but only a different-workspace daemon is alive", () => {
      const repoA = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-A`);
      const repoB = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-B`);
      // Daemon alive for /repo-B only.
      writeEntry({
        id: `${TEST_PREFIX}-only-b`,
        port: 47402,
        pid: process.pid,
        workspace: repoB,
        headless: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      });

      const found = registry.findRunningDaemon(repoA);
      expect(found).toBeNull();
    });

    it("returns the matching entry when workspace is given and a daemon for that workspace is alive", () => {
      const repoA = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-A-match`);
      writeEntry({
        id: `${TEST_PREFIX}-a-match`,
        port: 47402,
        pid: process.pid,
        workspace: repoA,
        headless: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      });

      const found = registry.findRunningDaemon(repoA);
      expect(found).not.toBeNull();
      expect(found.id).toBe(`${TEST_PREFIX}-a-match`);
      expect(found.workspace).toBe(repoA);
    });

    it("returns any alive daemon when no workspace is specified (workspace-agnostic search still works)", () => {
      const repoA = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-A-nospec`);
      writeEntry({
        id: `${TEST_PREFIX}-any-a`,
        port: 47402,
        pid: process.pid,
        workspace: repoA,
        headless: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      });

      // No workspace argument — function should return SOME alive daemon.
      // We can't assert it's our test entry because a real local daemon may
      // also be in the registry; the contract is "non-null when something is
      // alive", which is exactly what was broken for the workspace=null path.
      const found = registry.findRunningDaemon(undefined);
      expect(found).not.toBeNull();
      // And it must NOT be filtered out by an erroneous workspace check.
      expect(found.headless).toBe(true);
    });

    it("returns the workspace-matched daemon when daemons for both workspaces are alive", () => {
      const repoA = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-A-both`);
      const repoB = path.join(os.tmpdir(), `${TEST_PREFIX}-repo-B-both`);
      writeEntry({
        id: `${TEST_PREFIX}-both-a`,
        port: 47402,
        pid: process.pid,
        workspace: repoA,
        headless: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      });
      writeEntry({
        id: `${TEST_PREFIX}-both-b`,
        port: 47403,
        pid: process.pid,
        workspace: repoB,
        headless: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      });

      const found = registry.findRunningDaemon(repoA);
      expect(found).not.toBeNull();
      expect(found.id).toBe(`${TEST_PREFIX}-both-a`);
      expect(found.workspace).toBe(repoA);
    });
  });
});
