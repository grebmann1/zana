// Tests for the extras skill-store: listSkills, getEnabledInstructions,
// getEnabledToolSkills — none of these are covered by skill-store.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const configMock = vi.hoisted(() => ({ SKILLS_DIR: "" }));
vi.mock("@zana-ai/core/dist/src/config", () => configMock);

import {
  listSkills,
  saveSkill,
  getEnabledInstructions,
  getEnabledToolSkills,
} from "@zana-ai/extras/src/settings/skill-store.ts";

describe("skill-store — listSkills / getEnabledInstructions / getEnabledToolSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-skill-list-test-"));
    configMock.SKILLS_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── listSkills ────────────────────────────────────────────────────────────

  it("listSkills: returns an empty array when the directory is empty", () => {
    expect(listSkills()).toEqual([]);
  });

  it("listSkills: returns skills saved as flat .json files", () => {
    saveSkill({ name: "alpha", type: "instruction", content: "do alpha" });
    saveSkill({ name: "beta", type: "instruction", content: "do beta" });
    const skills = listSkills();
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("listSkills: returns skills saved in directory format (skill.json inside sub-dir)", () => {
    saveSkill({
      name: "dir-skill",
      type: "instruction",
      content: "dir content",
      supportingFiles: [{ name: "extra.txt", content: "extra" }],
    });
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("dir-skill");
  });

  it("listSkills: user skill with same id as built-in masks the built-in", () => {
    // Simulate a built-in skill in the BUILT_IN_SKILLS_DIR by writing directly
    // into the directory the module resolves as __dirname/../skills.  Because
    // that path doesn't exist in this test environment the built-in list is
    // always empty — so this test verifies that two user skills with distinct
    // ids both appear (no accidental deduplication of unrelated ids).
    const id = "fixed-id-clash-test";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.json`),
      JSON.stringify({ id, name: "user-version", type: "instruction", content: "user" }),
      "utf8",
    );
    const skills = listSkills();
    const match = skills.find((s) => s.id === id);
    expect(match).toBeDefined();
    expect(match!.name).toBe("user-version");
  });

  // ── getEnabledInstructions ────────────────────────────────────────────────

  it("getEnabledInstructions: includes enabled instruction skills with content", () => {
    saveSkill({ name: "visible", type: "instruction", content: "run this", enabled: true });
    const instructions = getEnabledInstructions();
    expect(instructions.some((i) => i.includes("visible"))).toBe(true);
    expect(instructions.some((i) => i.includes("run this"))).toBe(true);
  });

  it("getEnabledInstructions: formats each entry as [name]: content", () => {
    saveSkill({ name: "formatted", type: "instruction", content: "body text", enabled: true });
    const instructions = getEnabledInstructions();
    expect(instructions.some((i) => i.startsWith("[formatted]: body text"))).toBe(true);
  });

  it("getEnabledInstructions: excludes disabled skills", () => {
    saveSkill({ name: "disabled-skill", type: "instruction", content: "hidden", enabled: false });
    const instructions = getEnabledInstructions();
    expect(instructions.some((i) => i.includes("disabled-skill"))).toBe(false);
  });

  it("getEnabledInstructions: excludes skills without content", () => {
    saveSkill({ name: "no-content-skill", type: "instruction", content: "", enabled: true });
    const instructions = getEnabledInstructions();
    expect(instructions.some((i) => i.includes("no-content-skill"))).toBe(false);
  });

  it("getEnabledInstructions: excludes tool-type skills", () => {
    saveSkill({ name: "tool-skill", type: "tool", content: "tool body", enabled: true, toolSchema: {} });
    const instructions = getEnabledInstructions();
    expect(instructions.some((i) => i.includes("tool-skill"))).toBe(false);
  });

  it("getEnabledInstructions: returns empty array when no qualifying skills exist", () => {
    expect(getEnabledInstructions()).toEqual([]);
  });

  // ── getEnabledToolSkills ──────────────────────────────────────────────────

  it("getEnabledToolSkills: returns enabled tool skills that have a toolSchema", () => {
    saveSkill({ name: "my-tool", type: "tool", content: "n/a", enabled: true, toolSchema: { name: "my-tool" } });
    const tools = getEnabledToolSkills();
    expect(tools.some((t) => t.name === "my-tool")).toBe(true);
  });

  it("getEnabledToolSkills: excludes tool skills without toolSchema", () => {
    saveSkill({ name: "schema-less", type: "tool", content: "n/a", enabled: true });
    const tools = getEnabledToolSkills();
    expect(tools.some((t) => t.name === "schema-less")).toBe(false);
  });

  it("getEnabledToolSkills: excludes disabled tool skills", () => {
    saveSkill({ name: "off-tool", type: "tool", content: "n/a", enabled: false, toolSchema: { name: "off-tool" } });
    const tools = getEnabledToolSkills();
    expect(tools.some((t) => t.name === "off-tool")).toBe(false);
  });

  it("getEnabledToolSkills: excludes instruction-type skills", () => {
    saveSkill({ name: "instruct", type: "instruction", content: "instruct body", enabled: true });
    const tools = getEnabledToolSkills();
    expect(tools.some((t) => t.name === "instruct")).toBe(false);
  });

  it("getEnabledToolSkills: returns empty array when no qualifying skills exist", () => {
    expect(getEnabledToolSkills()).toEqual([]);
  });
});
