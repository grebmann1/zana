// Integration test for packages/core/src/daemon/registry.ts.
//
// Strategy: redirect HOME to a tmpdir before any @zana-ai/* module loads —
// `config.ts` derives DAEMONS_DIR from `os.homedir()`/`process.env.HOME` at
// module-load time. No internal modules are mocked. Process-liveness uses the
// current PID (always alive) or a bogus PID (999999999, always dead).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-daemon-registry-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as registry from "@zana-ai/core/src/daemon/registry.ts";

const daemonsTestDir = path.join(fakeHome, ".zana", "daemons");

beforeAll(() => {
  fs.mkdirSync(daemonsTestDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// Wipe the daemons dir before each test for isolation.
beforeEach(() => {
  for (const f of fs.readdirSync(daemonsTestDir)) {
    try { fs.unlinkSync(path.join(daemonsTestDir, f)); } catch {}
  }
});

// ── generateDaemonId ────────────────────────────────────────────────────────

describe("generateDaemonId()", () => {
  it("returns an 8-character string", () => {
    const id = registry.generateDaemonId();
    expect(typeof id).toBe("string");
    expect(id).toHaveLength(8);
  });

  it("produces unique ids on successive calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => registry.generateDaemonId()));
    expect(ids.size).toBe(20);
  });
});

// ── register ────────────────────────────────────────────────────────────────

describe("register()", () => {
  it("creates a JSON file named <id>.json in DAEMONS_DIR", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 1234, apiPort: null, workspace: "/tmp/ws" });
    expect(fs.existsSync(path.join(daemonsTestDir, `${id}.json`))).toBe(true);
  });

  it("returns an entry with id, port, pid, workspace, and timestamps", () => {
    const id = registry.generateDaemonId();
    const entry = registry.register({ id, port: 4000, apiPort: 4001, workspace: "/ws" });
    expect(entry.id).toBe(id);
    expect(entry.port).toBe(4000);
    expect(entry.apiPort).toBe(4001);
    expect(entry.pid).toBe(process.pid);
    expect(entry.workspace).toBe("/ws");
    expect(typeof entry.startedAt).toBe("string");
    expect(typeof entry.lastHeartbeat).toBe("string");
  });

  it("omits apiPort field when apiPort is null", () => {
    const id = registry.generateDaemonId();
    const entry = registry.register({ id, port: 5000, apiPort: null, workspace: "/ws" });
    expect("apiPort" in entry).toBe(false);
  });

  it("the on-disk JSON round-trips cleanly", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 7777, apiPort: 8888, workspace: "/round-trip" });
    const raw = fs.readFileSync(path.join(daemonsTestDir, `${id}.json`), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(id);
    expect(parsed.port).toBe(7777);
  });
});

// ── deregister ──────────────────────────────────────────────────────────────

describe("deregister()", () => {
  it("removes the JSON file and returns true", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 9000, apiPort: null, workspace: "/tmp" });
    expect(registry.deregister(id)).toBe(true);
    expect(fs.existsSync(path.join(daemonsTestDir, `${id}.json`))).toBe(false);
  });

  it("returns false for an id that was never registered", () => {
    expect(registry.deregister("no-such-id")).toBe(false);
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("list()", () => {
  it("returns an empty array when no daemons are registered", () => {
    expect(registry.list()).toEqual([]);
  });

  it("returns all registered entries", () => {
    const a = registry.generateDaemonId();
    const b = registry.generateDaemonId();
    registry.register({ id: a, port: 1, apiPort: null, workspace: "/a" });
    registry.register({ id: b, port: 2, apiPort: null, workspace: "/b" });
    const ids = registry.list().map((e) => e.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("ignores non-JSON files in the directory", () => {
    fs.writeFileSync(path.join(daemonsTestDir, "README.txt"), "not json");
    expect(() => registry.list()).not.toThrow();
  });

  it("skips files that contain invalid JSON without throwing", () => {
    fs.writeFileSync(path.join(daemonsTestDir, "corrupt.json"), "{{bad json}}");
    expect(() => registry.list()).not.toThrow();
    // The corrupt file should simply be ignored
    const ids = registry.list().map((e: any) => e.id);
    expect(ids.includes(undefined)).toBe(false);
  });
});

// ── cleanStale / listAlive ──────────────────────────────────────────────────

describe("cleanStale()", () => {
  it("removes entries whose heartbeat is older than STALE_THRESHOLD_MS", () => {
    const id = registry.generateDaemonId();
    const staleEntry = {
      id,
      port: 1111,
      pid: 999999999,   // dead PID — ensures isProcessAlive returns false
      workspace: "/stale",
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date(Date.now() - registry.STALE_THRESHOLD_MS - 5000).toISOString(),
    };
    fs.writeFileSync(
      path.join(daemonsTestDir, `${id}.json`),
      JSON.stringify(staleEntry, null, 2) + "\n",
      "utf8",
    );

    const removed = registry.cleanStale();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(daemonsTestDir, `${id}.json`))).toBe(false);
  });

  it("keeps entries with a fresh heartbeat and alive PID", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 2222, apiPort: null, workspace: "/fresh" });

    const removed = registry.cleanStale();
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(daemonsTestDir, `${id}.json`))).toBe(true);
  });
});

describe("listAlive()", () => {
  it("excludes entries with a dead PID even if heartbeat is fresh", () => {
    const id = registry.generateDaemonId();
    const deadEntry = {
      id,
      port: 3333,
      pid: 999999999,
      workspace: "/dead",
      headless: true,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(daemonsTestDir, `${id}.json`),
      JSON.stringify(deadEntry, null, 2) + "\n",
      "utf8",
    );

    const alive = registry.listAlive();
    expect(alive.find((e) => e.id === id)).toBeUndefined();
  });

  it("includes entries with the current PID and a fresh heartbeat", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 4444, apiPort: null, workspace: "/alive" });

    const alive = registry.listAlive();
    expect(alive.find((e) => e.id === id)).toBeDefined();
  });
});

// ── startHeartbeat ────────────────────────────────────────────────────────────

describe("startHeartbeat()", () => {
  it("rewrites lastHeartbeat on each interval tick and stops once the returned stop() is called", () => {
    const id = registry.generateDaemonId();
    const entry = registry.register({ id, port: 1234, apiPort: null, workspace: "/hb" });
    const file = path.join(daemonsTestDir, `${id}.json`);
    const initialHeartbeat = entry.lastHeartbeat;

    // Fake timers keep the interval deterministic. advanceTimersByTime also
    // advances the mocked clock, so the callback fires at start+interval and
    // stamps that instant (00:00:11 + 10s = 00:00:21).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-14T00:00:11.000Z"));
      const stop = registry.startHeartbeat(id);
      expect(typeof stop).toBe("function");

      // One interval elapses → the daemon file's heartbeat is refreshed.
      vi.advanceTimersByTime(registry.HEARTBEAT_INTERVAL_MS);
      const afterTick = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(afterTick.lastHeartbeat).toBe("2026-06-14T00:00:21.000Z");
      expect(afterTick.lastHeartbeat).not.toBe(initialHeartbeat);

      // After stop(), further elapsed time must NOT rewrite the heartbeat.
      stop();
      vi.advanceTimersByTime(registry.HEARTBEAT_INTERVAL_MS * 3);
      const afterStop = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(afterStop.lastHeartbeat).toBe("2026-06-14T00:00:21.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── findRunningDaemon ────────────────────────────────────────────────────────

describe("findRunningDaemon()", () => {
  it("returns null when no daemons are registered", () => {
    expect(registry.findRunningDaemon("/any")).toBeNull();
  });

  it("returns a headless daemon for the exact workspace", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 5555, apiPort: null, workspace: "/my-repo", headless: true });

    const found = registry.findRunningDaemon("/my-repo");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
  });

  it("does NOT return a daemon from a different workspace", () => {
    const id = registry.generateDaemonId();
    registry.register({ id, port: 6666, apiPort: null, workspace: "/repo-a", headless: true });

    expect(registry.findRunningDaemon("/repo-b")).toBeNull();
  });

  it("ignores a non-headless daemon for the requested workspace (auditor finding 6fcb24e6)", () => {
    // A daemon for the exact workspace exists and is alive, but it is NOT
    // headless. The workspace-scoped lookup requires `headless === true`, so a
    // non-headless daemon must NOT satisfy the concurrent-daemon guard.
    const id = registry.generateDaemonId();
    registry.register({ id, port: 7777, apiPort: null, workspace: "/repo-c", headless: false });

    expect(registry.findRunningDaemon("/repo-c")).toBeNull();
  });

  it("returns null when no workspace is given and no daemons are alive", () => {
    expect(registry.findRunningDaemon(null)).toBeNull();
  });

  it("prefers a headless daemon (not just alive[0]) when no workspace is given", () => {
    // No-workspace lookup must prefer a headless daemon over a non-headless one,
    // regardless of registration order. The non-headless daemon is registered
    // FIRST (so it tends to be alive[0]); findRunningDaemon(null) must still
    // return the headless daemon via `alive.find(e => e.headless)`, exercising
    // the branch that the existing tests never reach.
    const nonHeadless = registry.generateDaemonId();
    const headless = registry.generateDaemonId();
    registry.register({ id: nonHeadless, port: 8888, apiPort: null, workspace: "/repo-x", headless: false });
    registry.register({ id: headless, port: 8889, apiPort: null, workspace: "/repo-y", headless: true });

    const found = registry.findRunningDaemon(null);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(headless);
    expect(found!.headless).toBe(true);
  });
});
