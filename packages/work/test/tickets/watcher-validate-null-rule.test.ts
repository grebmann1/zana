// Covers the two validateRules() branches that no existing test exercises:
//   1. A null / non-object entry in the rules array
//      → error "rule is not an object"
//   2. A rule whose `action` key is absent entirely
//      → error "missing or invalid `action`"
//   3. A rule whose `trigger` key is absent entirely
//      → error "missing or invalid `trigger`"
//
// All three early-exit or error paths are in watcher.ts validateRules() but
// were invisible to the test suite (confirmed by grepping for the literal
// error strings across all test files).

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
  const cfgPath = path.join(tmpDir, `cfg-${Date.now()}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ automation }), "utf8");
  return cfgPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-null-rule-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── null / non-object rule entry ───────────────────────────────────────────

describe("validateRules — null rule entry", () => {
  it("reports an error when a rules array entry is null", () => {
    const cfg = writeCfg([null]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("rule is not an object"))).toBe(true);
  });

  it("reports an error when a rules array entry is a string (not an object)", () => {
    const cfg = writeCfg(["not-an-object"]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("rule is not an object"))).toBe(true);
  });

  it("uses 'idx-N' as the ruleName placeholder when the entry has no name", () => {
    // null has no .name property, so the ruleIndex-based fallback must fire.
    const cfg = writeCfg([null]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.some((w) => w.ruleName === "idx-0")).toBe(true);
  });
});

// ─── missing action ─────────────────────────────────────────────────────────

describe("validateRules — missing action", () => {
  it("reports an error when the action key is absent entirely", () => {
    // A rule object with a valid trigger but NO action key at all.
    const cfg = writeCfg([
      {
        name: "no-action-rule",
        trigger: { event: "ticket:created" },
        // deliberately no `action` key
      },
    ]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("missing or invalid `action`"))).toBe(true);
  });

  it("reports an error when action is null", () => {
    const cfg = writeCfg([
      {
        name: "null-action",
        trigger: { event: "ticket:created" },
        action: null,
      },
    ]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("missing or invalid `action`"))).toBe(true);
  });
});

// ─── missing trigger ─────────────────────────────────────────────────────────

describe("validateRules — missing trigger", () => {
  it("reports an error when the trigger key is absent entirely", () => {
    const cfg = writeCfg([
      {
        name: "no-trigger-rule",
        action: { spawnProfile: "reviewer" },
        // deliberately no `trigger` key
      },
    ]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("missing or invalid `trigger`"))).toBe(true);
  });

  it("attaches the correct ruleName when trigger is missing", () => {
    const cfg = writeCfg([
      {
        name: "bad-trigger",
        action: { spawnProfile: "reviewer" },
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.some((w) => w.ruleName === "bad-trigger")).toBe(true);
  });
});
