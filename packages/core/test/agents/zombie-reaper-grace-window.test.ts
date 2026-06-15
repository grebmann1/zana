import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  reapOnce,
  _setTestSeams,
  _resetTestSeams,
  stop as reaperStop,
} from "@zana-ai/core/src/agents/zombie-reaper.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zana-reaper-grace-"));
  moduleConfig.setConfigPath(path.join(tmp, "config.json"));
});

afterEach(() => {
  _resetTestSeams();
  reaperStop();
});

// The grace window is configurable via cfg.system.zombieReaperGraceMs and the
// boundary is inclusive: a process is reaped when etime >= floor(graceMs/1000),
// skipped when strictly below. The default-grace tests use far-apart values
// (60s vs 8 days), so neither the custom config value nor the exact boundary
// is otherwise exercised.
describe("reapOnce — configurable grace window honors zombieReaperGraceMs", () => {
  beforeEach(() => {
    moduleConfig.save({
      modules: {},
      system: {
        ...(moduleConfig.get()?.system || {}),
        zombieReaperEnabled: true,
        zombieReaperGraceMs: 120_000, // graceSec = 120
      },
    } as any);
  });

  it("skips below the custom grace, reaps at the boundary and above", () => {
    const killed: number[] = [];
    _setTestSeams({
      processLister: () => [
        { pid: 3001, ppid: 1, etimeSeconds: 119, command: "claude --name Young [a]" }, // < 120 → skip
        { pid: 3002, ppid: 1, etimeSeconds: 120, command: "claude --name Edge [b]" }, // == 120 → reap (inclusive)
        { pid: 3003, ppid: 1, etimeSeconds: 500, command: "claude --name Old [c]" }, // > 120 → reap
      ],
      killer: (pid) => {
        killed.push(pid);
      },
    });

    const result = reapOnce();

    expect(result.reaped).toEqual([3002, 3003]);
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(3);
    expect(killed).toEqual([3002, 3003]);
  });
});
