// Subagent provisioner — renders Zana profiles into Claude Code subagent recipe
// files (`.claude/agents/<name>.md`) so a SINGLE lead `claude` session can
// dispatch them in-process via the Task tool's `subagent_type`, instead of
// Zana's default of spawning one OS `claude` process per agent.
//
// This is the in-process alternative to the spawn-per-agent model in
// spawner.ts / lifecycle.ts. It is OPT-IN (system.executionStrategy ===
// "subagent") and is the right fit for a lead+roster team running in ONE repo.
// It is NOT a replacement for the daemon's process model — subagents are tool
// calls, so they have no independent lifecycle (can't kill/restart/retry one),
// no cross-session reach, and no per-worker ticket claim/complete. See ADR 0012.
//
// Mechanism is ported from Orchestranator's verified AgentProvisioner.swift:
//   • One `.claude/agents/<composite-slug>.md` per role, written into the lead's
//     working directory (where the claude CLI discovers project-scoped recipes).
//   • Composite slug `<team-slug>__<role-slug>` is used as BOTH the filename
//     stem and the recipe `name:`, so two teams sharing a workdir can't collide
//     and the lead's `subagent_type` is unambiguous. `slug()` only emits `-` for
//     non-alphanumerics, never `_`, so the `__` separator is safe.
//   • A `zana_stamp` (sha256 of the body) detects hand-edits: if a file's stored
//     stamp still matches its body, it is as Zana last wrote it and is safe to
//     overwrite; otherwise a human edited it and we leave it alone.
//
// Subagents NEVER see the lead's --append-system-prompt, so any imperative the
// lead carries (ticket lifecycle, wiki conventions) must be baked into each
// recipe body here — see buildRecipeBody.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export type ProvisionOutcome = "created" | "updated" | "unchanged" | "skipped-hand-edited";

export interface ProvisionResult {
  name: string;        // composite slug (also the subagent_type)
  file: string;        // absolute path written (or that would have been)
  outcome: ProvisionOutcome;
}

// A Zana profile, narrowed to the fields a recipe needs. Mirrors profile-store.
export interface ProfileLike {
  id: string;
  displayName?: string;
  description?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model?: string;
  allowedTools?: string[];
}

// Lowercase, map every run of non-[a-z0-9] to a single "-", trim leading/
// trailing "-". Claude Code requires subagent `name` to be lowercase letters and
// hyphens only (no underscores) — so slug() deliberately emits ONLY [a-z0-9-].
// Falls back to "role" when the input reduces to empty.
export function slug(input: string): string {
  const s = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "role";
}

// Composite name `<team>-<role>` — used as both the filename stem and the recipe
// `name:`/`subagent_type`, so two teams sharing a workdir don't collide. The
// Claude Code spec restricts `name` to lowercase + hyphens (no underscores), so
// we join with a single "-" rather than the "__" Orchestranator uses. Because
// both halves are already hyphen-slugged, the only way two distinct (team,role)
// pairs collide is if they slug to the same string — no worse than any scheme,
// and within one workdir the team slug is fixed.
export function compositeSlug(teamSlug: string, roleId: string): string {
  return `${slug(teamSlug)}-${slug(roleId)}`;
}

export function agentsDir(workingDirectory: string): string {
  return path.join(workingDirectory, ".claude", "agents");
}

// Build the recipe body. The subagent does NOT inherit the lead's appended
// system prompt, so everything it must obey is baked in here, in order:
//   profile.systemPrompt → appendSystemPrompt → any extra imperative blocks.
// A trailing newline is always present (recipe files are line-oriented).
export function buildRecipeBody(profile: ProfileLike, extraBlocks: string[] = []): string {
  const parts = [
    (profile.systemPrompt || "").trim(),
    (profile.appendSystemPrompt || "").trim(),
    ...extraBlocks.map((b) => (b || "").trim()),
  ].filter((p) => p.length > 0);
  if (parts.length === 0) {
    parts.push(`Role: ${profile.displayName || profile.id}`);
  }
  return parts.join("\n\n") + "\n";
}

function stampOf(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

// Escape a string for a single-line YAML scalar value. Newlines collapse to
// spaces (description may be multi-line); double-quotes are escaped.
function yamlInline(value: string): string {
  return String(value || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/"/g, '\\"')
    .trim();
}

// Render the full recipe file: YAML frontmatter (name, description, optional
// tools/model, zana_stamp) + a blank line + the body.
//
// `opts.inheritModel` (default false): when true, the `model:` line is OMITTED
// so the subagent INHERITS the lead/session model instead of pinning the
// profile's tier. This matters for cost: profiles tier to opus, but a team run
// driven by a cheaper lead model should not silently upgrade every dispatched
// subagent to opus (observed in the 2026-06-18 live A/B run — the opus-pinned
// recipes were the entire cost gap). The team path passes inheritModel:true.
export function renderRecipe(
  name: string,
  profile: ProfileLike,
  body: string,
  opts: { inheritModel?: boolean } = {},
): string {
  const lines = ["---", `name: ${name}`];
  const desc = yamlInline(profile.description || profile.displayName || name);
  lines.push(`description: "${desc}"`);
  // `tools` and `model` are optional in the recipe; omit them to inherit the
  // session defaults rather than pin a value the caller didn't set.
  if (Array.isArray(profile.allowedTools) && profile.allowedTools.length > 0) {
    lines.push(`tools: ${profile.allowedTools.join(", ")}`);
  }
  if (profile.model && !opts.inheritModel) {
    lines.push(`model: ${profile.model}`);
  }
  lines.push(`zana_stamp: ${stampOf(body)}`);
  lines.push("---", "");
  return lines.join("\n") + body;
}

// Extract the body (everything after the frontmatter) and the stored
// zana_stamp from a recipe file's content. Returns null fields when the file
// isn't in the expected shape — callers treat that as "not ours".
export function parseRecipe(content: string): { stamp: string | null; body: string | null } {
  // Frontmatter is the first `---\n ... \n---` block. The body is whatever
  // follows, with exactly the single separating blank line stripped so it
  // round-trips against buildRecipeBody.
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { stamp: null, body: null };
  const front = m[1];
  const stampMatch = front.match(/^zana_stamp:\s*([a-f0-9]+)\s*$/m);
  let body = content.slice(m[0].length);
  if (body.startsWith("\n")) body = body.slice(1);
  return { stamp: stampMatch ? stampMatch[1] : null, body };
}

// Provision a single role's recipe into <workingDirectory>/.claude/agents/.
// Idempotent and hand-edit-safe:
//   • file missing                       → write, "created"
//   • on-disk byte-identical to desired   → "unchanged" (no write)
//   • on-disk stamp matches its own body  → it's ours, overwrite, "updated"
//   • otherwise                           → a human edited it, "skipped-hand-edited"
export function provisionRole(opts: {
  workingDirectory: string;
  name: string;
  profile: ProfileLike;
  extraBlocks?: string[];
  inheritModel?: boolean;
}): ProvisionResult {
  const { workingDirectory, name, profile, extraBlocks = [], inheritModel = false } = opts;
  const dir = agentsDir(workingDirectory);
  const file = path.join(dir, `${name}.md`);
  const body = buildRecipeBody(profile, extraBlocks);
  const desired = renderRecipe(name, profile, body, { inheritModel });

  let existing: string | null = null;
  try { existing = fs.readFileSync(file, "utf8"); } catch { existing = null; }

  if (existing === null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, desired, "utf8");
    return { name, file, outcome: "created" };
  }
  if (existing === desired) {
    return { name, file, outcome: "unchanged" };
  }
  const { stamp, body: storedBody } = parseRecipe(existing);
  const isOurs = stamp !== null && storedBody !== null && stamp === stampOf(storedBody);
  if (isOurs) {
    fs.writeFileSync(file, desired, "utf8");
    return { name, file, outcome: "updated" };
  }
  // Stamp absent or no longer matches its body → a human (or another tool)
  // edited it. Preserve their edit.
  return { name, file, outcome: "skipped-hand-edited" };
}

// Provision a whole team roster. `teamSlug` namespaces the recipes; each
// profile becomes `<teamSlug>-<profile.id>.md`. Returns one result per role.
// `inheritModel` (default true here): a team's subagents should follow the
// lead's model tier rather than each pinning their profile's (often opus) model
// — see renderRecipe. Pass false to honor per-profile model pins.
export function provisionTeam(opts: {
  workingDirectory: string;
  teamSlug: string;
  profiles: ProfileLike[];
  extraBlocks?: string[];
  inheritModel?: boolean;
}): ProvisionResult[] {
  const { workingDirectory, teamSlug, profiles, extraBlocks = [], inheritModel = true } = opts;
  return profiles.map((profile) =>
    provisionRole({
      workingDirectory,
      name: compositeSlug(teamSlug, profile.id),
      profile,
      extraBlocks,
      inheritModel,
    }),
  );
}
