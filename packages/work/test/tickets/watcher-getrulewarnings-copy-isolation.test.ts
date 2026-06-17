// Tests the defensive-copy invariant of getRuleWarnings() in
// packages/work/src/tickets/watcher.ts. The accessor is documented as
// returning `ruleWarnings.slice()` so callers (CLI / HTTP API) cannot mutate
// the daemon's internal validation state. This guards that contract: the
// returned array must be a fresh reference, and mutating it must not leak back
// into the watcher or into a subsequent re-validation.
//
// Deterministic — config files only, no real Claude, no bus, no spawns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadRules,
  getRuleWarnings,
} from "@zana-ai/work/src/tickets/watcher.ts";

let tmpDir: string;

function writeCfg(automation: unknown) {
  const cfgPath = path.join(tmpDir, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ automation }), "utf8");
  return cfgPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-warn-copy-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRuleWarnings — defensive copy isolation", () => {
  it("returns a distinct array reference on each call", () => {
    // A rule with an unknown event produces at least one warning to copy.
    loadRules(writeCfg([
      { name: "typo", trigger: { event: "ticket:bogus" }, action: { spawnProfile: "p" } },
    ]));

    const first = getRuleWarnings();
    const second = getRuleWarnings();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);   // same contents
    expect(second).not.toBe(first);  // different reference (a copy, not the live array)
  });

  it("mutating the returned array does not corrupt internal state", () => {
    loadRules(writeCfg([
      { name: "typo", trigger: { event: "ticket:bogus" }, action: { spawnProfile: "p" } },
    ]));

    const snapshot = getRuleWarnings();
    const originalLength = snapshot.length;

    // Caller mutations: clear it and push junk.
    snapshot.length = 0;
    snapshot.push({ ruleIndex: 99, ruleName: "injected", level: "error", message: "tampered" } as never);

    // A fresh read must reflect the untouched internal state, not the mutation.
    const fresh = getRuleWarnings();
    expect(fresh).toHaveLength(originalLength);
    expect(fresh.some((w) => w.ruleName === "injected")).toBe(false);
  });
});
