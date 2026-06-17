// Covers a loadRules() fallback branch in
// packages/work/src/tickets/watcher.ts that no existing test exercises.
//
// Source guard:
//   if (Array.isArray(config.automation) && config.automation.length > 0) {
//     rules = config.automation;
//   } else {
//     rules = DEFAULT_RULES;
//   }
//
// The existing watcher-validate.test.ts fallback suite covers three paths:
//   - config file does not exist
//   - automation is an empty array ([])
//   - config JSON is malformed
// It never covers the case where `automation` is PRESENT but NOT an array
// (an object / string / number). Array.isArray() short-circuits to false and
// the rules must fall back to DEFAULT_RULES — a regression that did
// `rules = config.automation` for a truthy non-array value would load garbage
// rules and crash validateRules()/matchesRule() at runtime.
//
// Pure config-loading path: writes a temp JSON file, no real Claude / bus / spawns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadRules, getRules, getRuleWarnings } from "@zana-ai/work/src/tickets/watcher.ts";

let tmpDir: string;

function writeRawCfg(automation: unknown): string {
  const cfgPath = path.join(tmpDir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ automation }), "utf8");
  return cfgPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-nonarray-automation-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadRules — non-array `automation` falls back to DEFAULT_RULES", () => {
  it("falls back when automation is a plain object", () => {
    loadRules(writeRawCfg({ "on-create": { trigger: {}, action: {} } }));
    // DEFAULT_RULES is loaded (multiple entries), not the object.
    const rules = getRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    // The default review pipeline rule must be present, proving defaults loaded.
    expect(rules.some((r: any) => r?.action?.spawnProfile === "code-reviewer")).toBe(true);
    // Defaults are well-formed → no validation errors.
    expect(getRuleWarnings().filter((w) => w.level === "error")).toHaveLength(0);
  });

  it("falls back when automation is a string", () => {
    loadRules(writeRawCfg("not-an-array"));
    const rules = getRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(getRuleWarnings().filter((w) => w.level === "error")).toHaveLength(0);
  });
});
