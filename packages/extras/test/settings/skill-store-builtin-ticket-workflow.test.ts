// Regression test for the built-in `ticket-workflow` instruction skill.
//
// This skill is the contract spawned agents follow to interact with Zana
// tickets. Two things must hold for it to actually reach an agent:
//   1. it is discoverable via listSkills() as a built-in,
//   2. resolveSkillContent() inlines its {{file:GUIDE.md}} body (the GUIDE must
//      ship alongside the manifest — extras/scripts/copy-assets.js).
// It is global:false, so it only reaches profiles that opt in via skillIds —
// that wiring is asserted in the core spawner suite; here we pin the skill
// content + resolution.
//
// SKILLS_DIR (the USER skills dir) is redirected to an empty temp dir so this
// test reads ONLY the committed built-in, never a developer's local skills.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const configMock = vi.hoisted(() => ({ SKILLS_DIR: "" }));
vi.mock("@zana-ai/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zana-ai/contracts")>();
  return { ...actual, get SKILLS_DIR() { return configMock.SKILLS_DIR; } };
});

import {
  listSkills,
  getSkill,
  resolveSkillContent,
} from "@zana-ai/extras/src/settings/skill-store.ts";

describe("built-in ticket-workflow skill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-tw-skill-test-"));
    configMock.SKILLS_DIR = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is discoverable as a built-in instruction skill, scoped (global:false)", () => {
    const skill = listSkills().find((s) => s.id === "ticket-workflow");
    expect(skill).toBeTruthy();
    expect(skill.type).toBe("instruction");
    expect(skill.enabled).toBe(true);
    // global:false → only profiles that list it in skillIds receive it.
    expect(skill.global).toBe(false);
    expect(skill._builtIn).toBe(true);
  });

  it("resolves the GUIDE.md body via {{file:...}} (no missing-file marker)", () => {
    const skill = getSkill("ticket-workflow");
    const content = resolveSkillContent(skill);
    expect(content).toContain("--- TICKET WORKFLOW ---");
    // Body from GUIDE.md is inlined:
    expect(content).toContain("Working with Zana tickets");
    expect(content).toContain("zana_ticket_claim");
    expect(content).toContain("zana_ticket_verdict");
    expect(content).toContain("INCONCLUSIVE");
    expect(content).toContain("parentId"); // epics
    expect(content).toContain("zana_ticket_request_human"); // checkpoints
    // The template must have resolved — never leave the literal marker.
    expect(content).not.toContain("{{file:");
    expect(content).not.toContain("[file not found");
  });

  it("a user skill with the same id overrides the built-in", () => {
    // Write a user skill that shadows the built-in; listSkills must prefer it.
    fs.writeFileSync(
      path.join(tmpDir, "ticket-workflow.json"),
      JSON.stringify({ id: "ticket-workflow", name: "Override", type: "instruction", enabled: true, global: false, content: "overridden" }),
      "utf8",
    );
    const matches = listSkills().filter((s) => s.id === "ticket-workflow");
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe("Override");
  });
});
