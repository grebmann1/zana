// Tests for the subagent provisioner — rendering Zana profiles into Claude Code
// `.claude/agents/<name>.md` recipe files, the composite-slug naming, and the
// sha256 stamp / hand-edit guard ported from Orchestranator's AgentProvisioner.
//
// Pure + filesystem-only: each test uses a per-test temp working dir, no spawn,
// no claude, no daemon.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  slug,
  compositeSlug,
  agentsDir,
  buildRecipeBody,
  renderRecipe,
  parseRecipe,
  provisionRole,
  provisionTeam,
} from "@zana-ai/core/src/agents/subagent-provisioner.ts";

let wd: string;

beforeEach(() => {
  wd = fs.mkdtempSync(path.join(os.tmpdir(), "zana-subagent-prov-"));
});
afterEach(() => {
  try { fs.rmSync(wd, { recursive: true, force: true }); } catch {}
});

describe("slug / compositeSlug", () => {
  it("lowercases and collapses non-alphanumerics to single dashes, never underscores", () => {
    expect(slug("Code Reviewer!!")).toBe("code-reviewer");
    expect(slug("a__b  c")).toBe("a-b-c"); // underscores are non-[a-z0-9] → dashes
    expect(slug("---trim---")).toBe("trim");
  });
  it("falls back to 'role' for an empty reduction", () => {
    expect(slug("###")).toBe("role");
    expect(slug("")).toBe("role");
  });
  it("joins team + role with a hyphen (Claude Code names are lowercase+hyphen only, no underscores)", () => {
    const name = compositeSlug("Dev Team", "code_reviewer");
    expect(name).toBe("dev-team-code-reviewer");
    // Spec-compliant: only [a-z0-9-], no underscores.
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("renderRecipe / parseRecipe round-trip", () => {
  it("renders frontmatter + body and round-trips the stamp and body", () => {
    const profile = { id: "reviewer", displayName: "Reviewer", description: "Reviews code", allowedTools: ["Read", "Grep"], model: "claude-sonnet-4-6" };
    const body = buildRecipeBody(profile);
    const recipe = renderRecipe("team__reviewer", profile, body);

    expect(recipe).toMatch(/^---\nname: team__reviewer\n/);
    expect(recipe).toContain('description: "Reviews code"');
    expect(recipe).toContain("tools: Read, Grep");
    expect(recipe).toContain("model: claude-sonnet-4-6");

    const parsed = parseRecipe(recipe);
    expect(parsed.body).toBe(body);
    expect(parsed.stamp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("omits the model line when inheritModel is set (subagent follows lead tier)", () => {
    const profile = { id: "reviewer", description: "Reviews", model: "claude-opus-4-8", allowedTools: ["Read"] };
    const body = buildRecipeBody(profile);
    // Default: pins the profile model.
    expect(renderRecipe("t-r", profile, body)).toContain("model: claude-opus-4-8");
    // inheritModel: drops it so the recipe inherits the session/lead model.
    const inherited = renderRecipe("t-r", profile, body, { inheritModel: true });
    expect(inherited).not.toContain("model:");
    // tools are still emitted — only the model pin is dropped.
    expect(inherited).toContain("tools: Read");
  });

  it("omits the optional tools and model lines when the profile sets neither (inherit session defaults)", () => {
    // Documented invariant (renderRecipe): tools/model are optional and are
    // OMITTED rather than emitted empty when the caller didn't set them, so the
    // subagent inherits the session defaults instead of being pinned to a value
    // nobody chose. name/description/zana_stamp are always present.
    const profile = { id: "scout", displayName: "Scout", description: "Looks around" };
    const body = buildRecipeBody(profile);
    const recipe = renderRecipe("t-scout", profile, body);

    expect(recipe).not.toContain("tools:");
    expect(recipe).not.toContain("model:");
    expect(recipe).toContain("name: t-scout");
    expect(recipe).toContain('description: "Looks around"');
    expect(recipe).toMatch(/zana_stamp: [a-f0-9]{64}/);
    // Still a well-formed recipe: parseRecipe recovers the stamp and exact body.
    const parsed = parseRecipe(recipe);
    expect(parsed.body).toBe(body);
    expect(parsed.stamp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("collapses a multi-line description into a single YAML scalar", () => {
    const profile = { id: "x", description: "line one\nline two" };
    const recipe = renderRecipe("t__x", profile, buildRecipeBody(profile));
    expect(recipe).toContain('description: "line one line two"');
  });

  it("escapes embedded double-quotes so the description stays a valid YAML scalar", () => {
    // An unescaped quote in the double-quoted YAML scalar would terminate the
    // value early and corrupt the frontmatter. yamlInline must backslash-escape
    // every `"` in the description.
    const profile = { id: "x", description: 'Reviews "critical" code paths' };
    const recipe = renderRecipe("t__x", profile, buildRecipeBody(profile));
    expect(recipe).toContain('description: "Reviews \\"critical\\" code paths"');
    // The frontmatter still parses as our recipe (stamp recovered, body intact).
    const parsed = parseRecipe(recipe);
    expect(parsed.stamp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bakes systemPrompt + appendSystemPrompt + extra blocks into the body", () => {
    const profile = { id: "x", systemPrompt: "You are X.", appendSystemPrompt: "Be terse." };
    const body = buildRecipeBody(profile, ["TICKET LIFECYCLE: claim then complete."]);
    expect(body).toContain("You are X.");
    expect(body).toContain("Be terse.");
    expect(body).toContain("TICKET LIFECYCLE");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("falls back to a Role: line when the profile carries no prompt text", () => {
    expect(buildRecipeBody({ id: "scout", displayName: "Scout" })).toBe("Role: Scout\n");
  });

  // buildRecipeBody trims each part and drops empties via `.filter(p => p.length > 0)`
  // (subagent-provisioner.ts lines 83-87). The existing tests pin all-parts-present
  // and the all-empty `Role:` fallback, but NOT the middle case: a whitespace-only
  // systemPrompt must be DROPPED so the surviving appendSystemPrompt is not preceded
  // by a stray blank line. A regression that removed the trim/filter would emit a body
  // starting with "\n\n…" — which both reads wrong and breaks the stamp round-trip
  // (parseRecipe strips exactly one separating newline). This pins that invariant.
  it("drops whitespace-only parts so a surviving part has no leading blank line", () => {
    const profile = {
      id: "x",
      systemPrompt: "   \n  \t ",          // whitespace only → filtered out
      appendSystemPrompt: "Only this survives.",
    };
    const body = buildRecipeBody(profile);
    // The single surviving part stands alone — no leading newline, no "\n\n" join gap.
    expect(body).toBe("Only this survives.\n");
    // And it round-trips: rendering then parsing recovers the exact body byte-for-byte.
    const recipe = renderRecipe("t-x", profile, body);
    expect(parseRecipe(recipe).body).toBe(body);
  });
});

describe("provisionRole — idempotency + hand-edit guard", () => {
  const profile = { id: "reviewer", displayName: "Reviewer", description: "Reviews", allowedTools: ["Read"] };

  it("writes the file on first provision (created)", () => {
    const res = provisionRole({ workingDirectory: wd, name: "t__reviewer", profile });
    expect(res.outcome).toBe("created");
    expect(fs.existsSync(path.join(agentsDir(wd), "t__reviewer.md"))).toBe(true);
  });

  it("is a no-op when nothing changed (unchanged)", () => {
    provisionRole({ workingDirectory: wd, name: "t__reviewer", profile });
    const res = provisionRole({ workingDirectory: wd, name: "t__reviewer", profile });
    expect(res.outcome).toBe("unchanged");
  });

  it("overwrites its own file when the profile changes (updated)", () => {
    provisionRole({ workingDirectory: wd, name: "t__reviewer", profile });
    const res = provisionRole({
      workingDirectory: wd,
      name: "t__reviewer",
      profile: { ...profile, description: "Reviews code thoroughly" },
    });
    expect(res.outcome).toBe("updated");
    expect(fs.readFileSync(res.file, "utf8")).toContain("Reviews code thoroughly");
  });

  it("preserves a pre-existing foreign file with no frontmatter/stamp (skipped-hand-edited)", () => {
    // A user may hand-author a .claude/agents/<name>.md that was never written by
    // Zana — it has no frontmatter and thus no zana_stamp. parseRecipe returns
    // stamp=null, so the hand-edit guard (stamp !== null) must treat it as foreign
    // and refuse to overwrite it. This is the stamp-absent branch.
    const dir = agentsDir(wd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "t__reviewer.md");
    const foreign = "Just a plain markdown file a human wrote.\nNo frontmatter here.\n";
    fs.writeFileSync(file, foreign, "utf8");

    const res = provisionRole({ workingDirectory: wd, name: "t__reviewer", profile });

    expect(res.outcome).toBe("skipped-hand-edited");
    // The foreign content is untouched — Zana's recipe was NOT written.
    expect(fs.readFileSync(file, "utf8")).toBe(foreign);
  });

  it("preserves a hand-edited file (skipped-hand-edited)", () => {
    // Use a profile with prompt text so the BODY (which the stamp guards) has
    // something a human can edit.
    const p = { ...profile, systemPrompt: "You review code." };
    const first = provisionRole({ workingDirectory: wd, name: "t__reviewer", profile: p });
    // Simulate a human editing the BODY without updating the stamp.
    const tampered = fs.readFileSync(first.file, "utf8").replace("You review code.", "HUMAN EDIT to the body");
    fs.writeFileSync(first.file, tampered, "utf8");

    const res = provisionRole({
      workingDirectory: wd,
      name: "t__reviewer",
      profile: { ...p, systemPrompt: "New prompt from zana." },
    });
    expect(res.outcome).toBe("skipped-hand-edited");
    // The human's edit survives; Zana's new body was NOT written.
    expect(fs.readFileSync(first.file, "utf8")).toContain("HUMAN EDIT to the body");
    expect(fs.readFileSync(first.file, "utf8")).not.toContain("New prompt from zana.");
  });
});

describe("provisionTeam", () => {
  it("writes one composite-slug recipe per role into .claude/agents/", () => {
    const profiles = [
      { id: "coder", displayName: "Coder", description: "writes code" },
      { id: "reviewer", displayName: "Reviewer", description: "reviews code" },
    ];
    const results = provisionTeam({ workingDirectory: wd, teamSlug: "Feature Squad", profiles });

    expect(results.map((r) => r.name).sort()).toEqual(
      ["feature-squad-coder", "feature-squad-reviewer"],
    );
    expect(results.every((r) => r.outcome === "created")).toBe(true);
    const files = fs.readdirSync(agentsDir(wd)).sort();
    expect(files).toEqual(["feature-squad-coder.md", "feature-squad-reviewer.md"]);
  });

  it("defaults to inheritModel:true so team recipes omit the model pin (cost guard)", () => {
    // The team path must NOT pin each profile's (often opus) model — a cheaper
    // lead would silently upgrade every subagent. Default here is inheritModel:true.
    const profiles = [{ id: "coder", displayName: "Coder", model: "claude-opus-4-8" }];
    const results = provisionTeam({ workingDirectory: wd, teamSlug: "squad", profiles });
    const written = fs.readFileSync(results[0].file, "utf8");
    expect(written).not.toContain("model:");
    // Passing inheritModel:false honors the per-profile model pin.
    const pinned = provisionTeam({ workingDirectory: wd, teamSlug: "pinned", profiles, inheritModel: false });
    expect(fs.readFileSync(pinned[0].file, "utf8")).toContain("model: claude-opus-4-8");
  });

  it("two teams in one workdir do not collide (namespaced by team slug)", () => {
    const profiles = [{ id: "coder", displayName: "Coder" }];
    provisionTeam({ workingDirectory: wd, teamSlug: "alpha", profiles });
    provisionTeam({ workingDirectory: wd, teamSlug: "beta", profiles });
    const files = fs.readdirSync(agentsDir(wd)).sort();
    expect(files).toEqual(["alpha-coder.md", "beta-coder.md"]);
  });
});
