// dynamic-skills unit tests — loadToolSkills + handleScratchpad via tmp dirs.
//
// Strategy: @zana-ai/core is loaded via CJS require() inside the module, so
// vi.mock (ESM-layer) is bypassed. Instead we grab the real config object from
// the require cache — it is a plain mutable object — and swap the relevant
// fields for each test, restoring them in afterEach.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dir: string, name: string, obj: any): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj), "utf8");
}

// Grab the real core config object — same reference the module under test reads.
const req = createRequire(import.meta.url);
const coreConfig: Record<string, string> = req("@zana-ai/core").config;

// Import the module under test (after requiring core so the require cache is warm).
const { loadToolSkills, handleScratchpad } = await import(
  "../src/dynamic-skills.ts"
);

// ── loadToolSkills ─────────────────────────────────────────────────────────────

describe("loadToolSkills", () => {
  let origSkillsDir: string;

  beforeEach(() => {
    origSkillsDir = coreConfig.SKILLS_DIR;
    coreConfig.SKILLS_DIR = makeTmpDir("zana-skills-test-");
  });

  afterEach(() => {
    coreConfig.SKILLS_DIR = origSkillsDir;
  });

  it("returns [] when skills dir does not exist", () => {
    coreConfig.SKILLS_DIR = "/tmp/zana-no-such-dir-abcxyz";
    expect(loadToolSkills()).toEqual([]);
  });

  it("returns [] when skills dir is empty", () => {
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips non-JSON files", () => {
    fs.writeFileSync(path.join(coreConfig.SKILLS_DIR, "readme.md"), "not json", "utf8");
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips skills where type !== 'tool'", () => {
    writeSkill(coreConfig.SKILLS_DIR, "chat.json", {
      type: "chat",
      enabled: true,
      toolSchema: { name: "chat_tool" },
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips disabled tool-skills", () => {
    writeSkill(coreConfig.SKILLS_DIR, "disabled.json", {
      type: "tool",
      enabled: false,
      toolSchema: { name: "disabled_tool" },
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips tool-skills with no toolSchema", () => {
    writeSkill(coreConfig.SKILLS_DIR, "no-schema.json", {
      type: "tool",
      enabled: true,
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("returns skill + schema for a valid, enabled tool-skill", () => {
    const skill = {
      type: "tool",
      enabled: true,
      handler: "scratchpad",
      toolSchema: { name: "zana_scratchpad", description: "A scratch tool" },
    };
    writeSkill(coreConfig.SKILLS_DIR, "scratchpad.json", skill);
    const results = loadToolSkills();
    expect(results).toHaveLength(1);
    expect(results[0].skill.handler).toBe("scratchpad");
    expect(results[0].schema.name).toBe("zana_scratchpad");
  });

  it("loads multiple valid tool-skills and ignores invalid ones", () => {
    writeSkill(coreConfig.SKILLS_DIR, "a.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_a" },
    });
    writeSkill(coreConfig.SKILLS_DIR, "b.json", {
      type: "tool", enabled: false, toolSchema: { name: "tool_b" },
    });
    writeSkill(coreConfig.SKILLS_DIR, "c.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_c" },
    });
    const results = loadToolSkills();
    expect(results).toHaveLength(2);
    const names = results.map((r: any) => r.schema.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_c");
    expect(names).not.toContain("tool_b");
  });

  it("silently skips a malformed JSON file and still loads the others", () => {
    fs.writeFileSync(path.join(coreConfig.SKILLS_DIR, "broken.json"), "{{{bad json", "utf8");
    writeSkill(coreConfig.SKILLS_DIR, "good.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_good" },
    });
    const results = loadToolSkills();
    expect(results).toHaveLength(1);
    expect(results[0].schema.name).toBe("tool_good");
  });
});

// ── handleScratchpad ───────────────────────────────────────────────────────────

describe("handleScratchpad", () => {
  let origScratchpadDir: string;

  beforeEach(() => {
    origScratchpadDir = coreConfig.SCRATCHPAD_DIR;
    coreConfig.SCRATCHPAD_DIR = makeTmpDir("zana-scratch-test-");
  });

  afterEach(() => {
    coreConfig.SCRATCHPAD_DIR = origScratchpadDir;
  });

  it("read on a missing file returns empty string", () => {
    const result = handleScratchpad({ action: "read" });
    expect(result).toEqual({ content: "" });
  });

  it("write creates the file and read retrieves the content", () => {
    handleScratchpad({ action: "write", content: "hello world" });
    const result = handleScratchpad({ action: "read" });
    expect(result).toEqual({ content: "hello world" });
  });

  it("write overwrites previous content", () => {
    handleScratchpad({ action: "write", content: "first" });
    handleScratchpad({ action: "write", content: "second" });
    expect(handleScratchpad({ action: "read" })).toEqual({ content: "second" });
  });

  it("append adds a line to existing content", () => {
    handleScratchpad({ action: "write", content: "line1" });
    handleScratchpad({ action: "append", content: "line2" });
    const { content } = handleScratchpad({ action: "read" });
    expect(content).toContain("line1");
    expect(content).toContain("line2");
  });

  it("append on a missing file creates the file", () => {
    handleScratchpad({ action: "append", content: "only line" });
    const result = handleScratchpad({ action: "read" });
    expect(result.content).toContain("only line");
  });

  it("write with no content writes an empty file", () => {
    handleScratchpad({ action: "write" });
    expect(handleScratchpad({ action: "read" })).toEqual({ content: "" });
  });

  it("unknown action returns an error object", () => {
    const result = handleScratchpad({ action: "delete" });
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/unknown action/);
  });
});
