// Tests for validateRules() / loadRules() / getRuleWarnings() in
// packages/work/src/tickets/watcher.ts.
// The rule-loading + validation path is separate from the pure helpers
// already covered in watcher-pure.test.ts and requires writing temporary
// config files — still no real Claude, no real bus, no real spawns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadRules,
  getRuleWarnings,
  getRules,
} from "@zana-ai/work/src/tickets/watcher.ts";

let tmpDir: string;

function writeCfg(automation: unknown) {
  const cfgPath = path.join(tmpDir, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ automation }), "utf8");
  return cfgPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-validate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── valid rules produce no warnings ───────────────────────────────────────

describe("loadRules + getRuleWarnings — valid rules", () => {
  it("produces no warnings for a well-formed spawnAgent rule", () => {
    const cfg = writeCfg([
      {
        name: "on-create",
        trigger: { event: "ticket:created" },
        action: { spawnProfile: "triager" },
      },
    ]);
    loadRules(cfg);
    expect(getRuleWarnings()).toHaveLength(0);
  });

  it("accepts legacy { status } trigger without warning", () => {
    const cfg = writeCfg([
      {
        name: "legacy-qa",
        trigger: { status: "review", reviewPhase: "qa" },
        action: { spawnProfile: "code-reviewer" },
      },
    ]);
    loadRules(cfg);
    expect(getRuleWarnings()).toHaveLength(0);
  });

  it("accepts all valid event names without errors", () => {
    const events = [
      "ticket:created", "ticket:claimed", "ticket:statusChanged",
      "ticket:reviewPhaseChanged", "ticket:commented", "ticket:completed",
      "ticket:updated",
    ];
    for (const event of events) {
      const cfg = writeCfg([
        { name: event, trigger: { event }, action: { spawnProfile: "p" } },
      ]);
      loadRules(cfg);
      const errs = getRuleWarnings().filter((w) => w.level === "error");
      expect(errs, `expected no errors for event=${event}`).toHaveLength(0);
    }
  });
});

// ─── invalid rules produce the expected warnings ────────────────────────────

describe("loadRules + getRuleWarnings — invalid rules", () => {
  it("reports an error for an unknown event name", () => {
    const cfg = writeCfg([
      {
        name: "typo",
        trigger: { event: "ticket:statusChange" }, // missing 'd'
        action: { spawnProfile: "p" },
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.some((w) => w.level === "error" && w.message.includes("unknown event"))).toBe(true);
  });

  it("reports an error when action.spawnProfile is missing", () => {
    const cfg = writeCfg([
      {
        name: "no-profile",
        trigger: { event: "ticket:created" },
        action: {},
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.some((w) => w.level === "error" && w.message.includes("spawnProfile"))).toBe(true);
  });

  it("reports a warning for an unknown trigger field", () => {
    const cfg = writeCfg([
      {
        name: "extra-field",
        trigger: { event: "ticket:created", priority: "high" }, // 'priority' is not in schema
        action: { spawnProfile: "p" },
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.some((w) => w.level === "warn" && w.message.includes("priority"))).toBe(true);
  });

  it("attaches the correct rule name to each warning", () => {
    const cfg = writeCfg([
      {
        name: "bad-rule",
        trigger: { event: "ticket:nonexistent" },
        action: { spawnProfile: "p" },
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings();
    expect(warnings.every((w) => w.ruleName === "bad-rule")).toBe(true);
  });
});

// ─── workflow action type ───────────────────────────────────────────────────

describe("loadRules + getRuleWarnings — workflow action", () => {
  it("accepts a workflow action with skillId without errors", () => {
    const cfg = writeCfg([
      {
        name: "on-created-workflow",
        trigger: { event: "ticket:created" },
        action: { type: "workflow", skillId: "my-skill" },
      },
    ]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports an error for a workflow action missing skillId", () => {
    const cfg = writeCfg([
      {
        name: "workflow-no-skill",
        trigger: { event: "ticket:created" },
        action: { type: "workflow" },
      },
    ]);
    loadRules(cfg);
    const errors = getRuleWarnings().filter((w) => w.level === "error");
    expect(errors.some((w) => w.message.includes("skillId"))).toBe(true);
  });

  it("reports a warning for an unknown action.type", () => {
    const cfg = writeCfg([
      {
        name: "unknown-type",
        trigger: { event: "ticket:created" },
        action: { type: "notify", spawnProfile: "p" },
      },
    ]);
    loadRules(cfg);
    const warnings = getRuleWarnings().filter((w) => w.level === "warn");
    expect(warnings.some((w) => w.message.includes("notify"))).toBe(true);
  });
});

// ─── fallback to DEFAULT_RULES on bad / missing config ──────────────────────

describe("loadRules — fallback behaviour", () => {
  it("falls back to DEFAULT_RULES when the config file does not exist", () => {
    loadRules(path.join(tmpDir, "nonexistent.json"));
    // DEFAULT_RULES has 3 entries and they're all valid
    expect(getRules().length).toBeGreaterThanOrEqual(1);
    expect(getRuleWarnings().filter((w) => w.level === "error")).toHaveLength(0);
  });

  it("falls back to DEFAULT_RULES when automation array is empty", () => {
    const cfg = writeCfg([]);
    loadRules(cfg);
    expect(getRules().length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to DEFAULT_RULES when config JSON is malformed", () => {
    const cfgPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(cfgPath, "not json {{{", "utf8");
    loadRules(cfgPath);
    expect(getRules().length).toBeGreaterThanOrEqual(1);
  });
});
