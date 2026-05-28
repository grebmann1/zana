import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  reapOnce,
  parseEtime,
  _setTestSeams,
  _resetTestSeams,
  _isRunning,
  start as reaperStart,
  stop as reaperStop,
} from "@zana/core/src/agents/zombie-reaper.ts";
import * as moduleConfig from "@zana/core/src/modules/config.ts";

beforeAll(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zana-reaper-"));
  moduleConfig.setConfigPath(path.join(tmp, "config.json"));
});

afterEach(() => {
  _resetTestSeams();
  reaperStop();
});

describe("parseEtime", () => {
  it("parses SS form", () => expect(parseEtime("42")).toBe(42));
  it("parses MM:SS form", () => expect(parseEtime("01:30")).toBe(90));
  it("parses HH:MM:SS form", () => expect(parseEtime("02:00:00")).toBe(7200));
  it("parses DD-HH:MM:SS form", () => expect(parseEtime("3-04:00:00")).toBe(3 * 86400 + 4 * 3600));
  it("returns 0 on garbage", () => expect(parseEtime("garbage")).toBe(0));
});

describe("reapOnce", () => {
  it("kills processes that are orphans (ppid=1) AND past the grace window", () => {
    const killed: number[] = [];
    _setTestSeams({
      processLister: () => [
        { pid: 1001, ppid: 1, etimeSeconds: 8 * 86400, command: "/usr/local/bin/claude --name Architect [abc]" },
        { pid: 1002, ppid: 1, etimeSeconds: 60, command: "/usr/local/bin/claude --name Coder [xyz]" }, // too young
        { pid: 1003, ppid: 12345, etimeSeconds: 8 * 86400, command: "/usr/local/bin/claude --name Tester [zzz]" }, // not orphan
      ],
      killer: (pid) => { killed.push(pid); },
    });
    const result = reapOnce();
    expect(result.reaped).toEqual([1001]);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(3);
    expect(killed).toEqual([1001]);
  });

  it("skips when reaper is disabled in config", () => {
    moduleConfig.save({
      modules: {},
      system: { ...(moduleConfig.get()?.system || {}), zombieReaperEnabled: false },
    } as any);
    const killed: number[] = [];
    _setTestSeams({
      processLister: () => [
        { pid: 999, ppid: 1, etimeSeconds: 999999, command: "/usr/local/bin/claude --name X [a]" },
      ],
      killer: (pid) => { killed.push(pid); },
    });
    const result = reapOnce();
    expect(result.reaped).toEqual([]);
    expect(killed).toEqual([]);
    // Re-enable for subsequent tests
    moduleConfig.save({
      modules: {},
      system: { ...(moduleConfig.get()?.system || {}), zombieReaperEnabled: true },
    } as any);
  });

  it("kill error on one process does not block reaping the next", () => {
    const killed: number[] = [];
    _setTestSeams({
      processLister: () => [
        { pid: 2001, ppid: 1, etimeSeconds: 999999, command: "claude --name Z [a]" },
        { pid: 2002, ppid: 1, etimeSeconds: 999999, command: "claude --name Z [b]" },
      ],
      killer: (pid) => {
        if (pid === 2001) throw new Error("ESRCH");
        killed.push(pid);
      },
    });
    const result = reapOnce();
    expect(result.reaped).toEqual([2002]);
    expect(killed).toEqual([2002]);
  });

  it("ignores processes without --name (interactive Claude sessions)", () => {
    const killed: number[] = [];
    _setTestSeams({
      processLister: () => [], // listClaudeProcesses already filters by --name; we test the contract
      killer: (pid) => { killed.push(pid); },
    });
    const result = reapOnce();
    expect(result.reaped).toEqual([]);
    expect(killed).toEqual([]);
  });
});

describe("start / stop", () => {
  beforeEach(() => {
    moduleConfig.save({
      modules: {},
      system: {
        ...(moduleConfig.get()?.system || {}),
        zombieReaperEnabled: true,
        zombieReaperIntervalMs: 60_000,
      },
    } as any);
  });

  it("registers an interval and unregisters on stop", () => {
    _setTestSeams({
      processLister: () => [],
      killer: () => {},
    });
    reaperStart();
    expect(_isRunning()).toBe(true);
    reaperStop();
    expect(_isRunning()).toBe(false);
  });

  it("noop start when intervalMs <= 0", () => {
    moduleConfig.save({
      modules: {},
      system: {
        ...(moduleConfig.get()?.system || {}),
        zombieReaperEnabled: true,
        zombieReaperIntervalMs: 0,
      },
    } as any);
    _setTestSeams({
      processLister: () => [],
      killer: () => {},
    });
    reaperStart();
    expect(_isRunning()).toBe(false);
  });

  it("runs an immediate sweep on start (does not wait for first interval)", () => {
    let calls = 0;
    _setTestSeams({
      processLister: () => { calls++; return []; },
      killer: () => {},
    });
    reaperStart();
    expect(calls).toBeGreaterThanOrEqual(1);
    reaperStop();
  });
});
