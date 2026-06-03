// Tests for the extras skill-store: save, get, delete, toggle, resolveSkillContent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// vi.hoisted() runs in the hoisted zone so the returned object is available to
// both the vi.mock factory (also hoisted) and the test code below.
const configMock = vi.hoisted(() => ({ SKILLS_DIR: "" }));

vi.mock("@zana-ai/core/dist/src/config", () => configMock);

import {
  saveSkill,
  getSkill,
  deleteSkill,
  toggleSkill,
  resolveSkillContent,
} from "@zana-ai/extras/src/settings/skill-store.ts";

describe("skill-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-skill-store-test-"));
    configMock.SKILLS_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── saveSkill ────────────────────────────────────────────────────────────

  it("saveSkill: assigns an id and timestamps when none provided", () => {
    const skill = saveSkill({ name: "my-skill", type: "instruction", content: "do things" });
    expect(typeof skill.id).toBe("string");
    expect(skill.id.length).toBeGreaterThan(0);
    expect(typeof skill.createdAt).toBe("string");
    expect(typeof skill.updatedAt).toBe("string");
  });

  it("saveSkill: applies default type, enabled, global, description", () => {
    const skill = saveSkill({ name: "bare" });
    expect(skill.type).toBe("instruction");
    expect(skill.enabled).toBe(true);
    expect(skill.global).toBe(true);
    expect(skill.description).toBe("");
  });

  it("saveSkill: persists to disk so getSkill can retrieve it", () => {
    const saved = saveSkill({ name: "persist-me", content: "hello" });
    const fetched = getSkill(saved.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("persist-me");
    expect(fetched!.content).toBe("hello");
  });

  it("saveSkill: retains explicit id and does not regenerate createdAt on re-save", () => {
    const first = saveSkill({ name: "stable", content: "v1" });
    const firstCreatedAt = first.createdAt;
    const second = saveSkill({ ...first, content: "v2" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(firstCreatedAt);
    expect(second.content).toBe("v2");
  });

  it("saveSkill: writes supporting files into a sub-directory", () => {
    const skill = saveSkill({
      name: "with-files",
      content: "body",
      supportingFiles: [{ name: "readme.txt", content: "file content here" }],
    });
    const dirPath = path.join(tmpDir, skill.id);
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(path.join(dirPath, "skill.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dirPath, "readme.txt"), "utf8")).toBe("file content here");
  });

  // ── getSkill ─────────────────────────────────────────────────────────────

  it("getSkill: returns null for unknown id", () => {
    expect(getSkill("does-not-exist-xyz")).toBeNull();
  });

  it("getSkill: returns null for falsy id", () => {
    expect(getSkill("")).toBeNull();
    expect(getSkill(null as any)).toBeNull();
  });

  it("getSkill: sanitizes path-traversal characters so no file matches", () => {
    // "../../etc/passwd" sanitizes to empty string → no match → null
    expect(getSkill("../../etc/passwd")).toBeNull();
  });

  // ── deleteSkill ───────────────────────────────────────────────────────────

  it("deleteSkill: removes a flat-file skill and returns true", () => {
    const skill = saveSkill({ name: "delete-me", content: "bye" });
    expect(deleteSkill(skill.id)).toBe(true);
    expect(getSkill(skill.id)).toBeNull();
  });

  it("deleteSkill: returns false for a non-existent id", () => {
    expect(deleteSkill("ghost-skill-999")).toBe(false);
  });

  // ── toggleSkill ───────────────────────────────────────────────────────────

  it("toggleSkill: disables an enabled skill", () => {
    const skill = saveSkill({ name: "toggle-test", content: "x", enabled: true });
    const result = toggleSkill(skill.id, false);
    expect(result).toBe(true);
    expect(getSkill(skill.id)!.enabled).toBe(false);
  });

  it("toggleSkill: re-enables a disabled skill", () => {
    const skill = saveSkill({ name: "toggle-on", content: "x", enabled: false });
    toggleSkill(skill.id, true);
    expect(getSkill(skill.id)!.enabled).toBe(true);
  });

  it("toggleSkill: returns false for unknown id", () => {
    expect(toggleSkill("no-such-skill", true)).toBe(false);
  });

  // ── resolveSkillContent ───────────────────────────────────────────────────

  it("resolveSkillContent: returns content unchanged when no flags or _dirName", () => {
    const skill = { name: "plain", content: "static content" };
    expect(resolveSkillContent(skill)).toBe("static content");
  });

  it("resolveSkillContent: appends disableModelInvocation notice", () => {
    const skill = { name: "read-only", content: "findings", disableModelInvocation: true };
    const result = resolveSkillContent(skill);
    expect(result).toContain("findings");
    expect(result).toContain("Do NOT invoke any tools");
  });

  it("resolveSkillContent: resolves {{file:filename}} template from skill directory", () => {
    const dirName = "file-template-skill";
    const skillDir = path.join(tmpDir, dirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "prompt.txt"), "injected file content");

    const skill = {
      name: "with-template",
      content: "preamble\n{{file:prompt.txt}}\npostamble",
      _dirName: dirName,
      _baseDir: tmpDir,
    };
    expect(resolveSkillContent(skill)).toBe("preamble\ninjected file content\npostamble");
  });

  it("resolveSkillContent: substitutes [file not found] for a missing template file", () => {
    const dirName = "missing-files-skill";
    fs.mkdirSync(path.join(tmpDir, dirName), { recursive: true });

    const skill = {
      name: "broken",
      content: "before {{file:nonexistent.txt}} after",
      _dirName: dirName,
      _baseDir: tmpDir,
    };
    expect(resolveSkillContent(skill)).toContain("[file not found: nonexistent.txt]");
  });
});
