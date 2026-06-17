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
const coreConfig: Record<string, string> = req("@zana-ai/contracts/dist/src/config");

// Import the module under test (after requiring core so the require cache is warm).
const { loadToolSkills, handleScratchpad, isValidToolSchema } = await import(
  "../src/dynamic-skills.ts"
);

// A minimal well-formed MCP tool schema: non-empty name + object inputSchema.
const OBJ_SCHEMA = { type: "object", properties: {} };

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

  it("returns [] when SKILLS_DIR points at a file, not a directory (non-ENOENT readdir error)", () => {
    // Covers the `err.code !== "ENOENT"` branch: readdirSync on a regular file
    // throws ENOTDIR. The loader must swallow it and return [] rather than throw.
    const filePath = path.join(makeTmpDir("zana-skills-notdir-"), "not-a-dir.txt");
    fs.writeFileSync(filePath, "i am a file", "utf8");
    coreConfig.SKILLS_DIR = filePath;
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
      toolSchema: { name: "chat_tool", inputSchema: OBJ_SCHEMA },
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips disabled tool-skills", () => {
    writeSkill(coreConfig.SKILLS_DIR, "disabled.json", {
      type: "tool",
      enabled: false,
      toolSchema: { name: "disabled_tool", inputSchema: OBJ_SCHEMA },
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
      toolSchema: { name: "zana_scratchpad", description: "A scratch tool", inputSchema: OBJ_SCHEMA },
    };
    writeSkill(coreConfig.SKILLS_DIR, "scratchpad.json", skill);
    const results = loadToolSkills();
    expect(results).toHaveLength(1);
    expect(results[0].skill.handler).toBe("scratchpad");
    expect(results[0].schema.name).toBe("zana_scratchpad");
  });

  it("loads multiple valid tool-skills and ignores invalid ones", () => {
    writeSkill(coreConfig.SKILLS_DIR, "a.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_a", inputSchema: OBJ_SCHEMA },
    });
    writeSkill(coreConfig.SKILLS_DIR, "b.json", {
      type: "tool", enabled: false, toolSchema: { name: "tool_b", inputSchema: OBJ_SCHEMA },
    });
    writeSkill(coreConfig.SKILLS_DIR, "c.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_c", inputSchema: OBJ_SCHEMA },
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
      type: "tool", enabled: true, toolSchema: { name: "tool_good", inputSchema: OBJ_SCHEMA },
    });
    const results = loadToolSkills();
    expect(results).toHaveLength(1);
    expect(results[0].schema.name).toBe("tool_good");
  });

  // Regression: a tool-skill whose toolSchema is present-but-malformed (no
  // name and/or no inputSchema) used to be published RAW into tools/list. The
  // MCP client validates every entry and rejects the WHOLE batch on one bad
  // one — and because the skills dir is global, a single stray fixture took
  // down Zana's tool surface in every project. These must now be skipped.
  it("skips a tool-skill with an empty toolSchema ({})", () => {
    writeSkill(coreConfig.SKILLS_DIR, "empty.json", {
      type: "tool", enabled: true, toolSchema: {},
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips a tool-skill whose toolSchema has a name but no inputSchema", () => {
    writeSkill(coreConfig.SKILLS_DIR, "no-input.json", {
      type: "tool", enabled: true, toolSchema: { name: "my-tool" },
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("skips a tool-skill whose toolSchema has an inputSchema but no name", () => {
    writeSkill(coreConfig.SKILLS_DIR, "no-name.json", {
      type: "tool", enabled: true, toolSchema: { inputSchema: OBJ_SCHEMA },
    });
    expect(loadToolSkills()).toEqual([]);
  });

  it("keeps the valid tool-skills even when a malformed one sits beside them", () => {
    writeSkill(coreConfig.SKILLS_DIR, "bad.json", {
      type: "tool", enabled: true, toolSchema: {},
    });
    writeSkill(coreConfig.SKILLS_DIR, "ok.json", {
      type: "tool", enabled: true, toolSchema: { name: "tool_ok", inputSchema: OBJ_SCHEMA },
    });
    const results = loadToolSkills();
    expect(results).toHaveLength(1);
    expect(results[0].schema.name).toBe("tool_ok");
  });
});

// ── isValidToolSchema ────────────────────────────────────────────────────────────

describe("isValidToolSchema", () => {
  it("accepts a schema with a non-empty name and an object inputSchema", () => {
    expect(isValidToolSchema({ name: "t", inputSchema: OBJ_SCHEMA })).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["missing inputSchema", { name: "t" }],
    ["missing name", { inputSchema: OBJ_SCHEMA }],
    ["empty name", { name: "", inputSchema: OBJ_SCHEMA }],
    ["non-string name", { name: 42, inputSchema: OBJ_SCHEMA }],
    ["null inputSchema", { name: "t", inputSchema: null }],
    ["non-object inputSchema", { name: "t", inputSchema: "nope" }],
  ])("rejects %s", (_label, schema) => {
    expect(isValidToolSchema(schema)).toBe(false);
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
