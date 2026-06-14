/**
 * Focused test: listPlans silently skips .md files whose frontmatter has no `id` field.
 *
 * plans-store.ts line ~168: `if (meta.id) plans.push(meta)` — any .md file that:
 *   (a) has no frontmatter block at all (parseFrontmatter returns meta = {}), or
 *   (b) has frontmatter but omits the `id` key
 * …must be silently ignored so that hand-authored, externally-dropped, or
 * corrupt plan files never surface as opaque plan objects in listPlans results.
 *
 * This path was not exercised by any of the existing plans-store test files,
 * which exclusively work through createPlan (always writes id) or inject files
 * that carry a valid id field.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  createPlan,
  listPlans,
  getPlan,
} from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-noid-${process.pid}`,
);

let plansDir: string;

beforeEach(() => {
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  plansDir = workspaceContext.getProjectPaths().plansDir;
  fs.mkdirSync(plansDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

// ── helpers ──────────────────────────────────────────────────────────────────

function writeMdFile(name: string, content: string): void {
  fs.writeFileSync(path.join(plansDir, name), content, "utf8");
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("plans-store listPlans — skips files with no `id` in frontmatter", () => {
  it("skips a .md file with frontmatter that has no id field", () => {
    // This file looks like a plan but is missing `id` — should be invisible to listPlans.
    writeMdFile("no-id.md", [
      "---",
      "title: No ID Plan",
      "status: draft",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "Body without id.",
    ].join("\n"));

    const plans = listPlans();
    const match = plans.find((p: any) => p.title === "No ID Plan");
    expect(match).toBeUndefined();
    expect(plans.length).toBe(0);
  });

  it("skips a .md file with no frontmatter block at all", () => {
    // parseFrontmatter returns meta = {} when no --- block exists.
    // meta.id is therefore falsy → the file must be silently skipped.
    writeMdFile("bare-markdown.md", [
      "# Just a Heading",
      "",
      "This file has no YAML frontmatter at all.",
    ].join("\n"));

    const plans = listPlans();
    expect(plans.length).toBe(0);
  });

  it("returns valid plans and ignores id-less files in the same directory", () => {
    // A valid plan co-existing with a no-id file — only the valid one appears.
    const good = createPlan({
      title: "Valid Plan",
      content: "content",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });

    writeMdFile("orphan.md", [
      "---",
      "title: Orphan (no id)",
      "status: draft",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "body",
    ].join("\n"));

    const plans = listPlans();
    expect(plans.length).toBe(1);
    expect(plans[0].id).toBe(good.id);
    expect(plans[0].title).toBe("Valid Plan");
  });

  it("getPlan on a file with no frontmatter block is safe (does not throw)", () => {
    // parseFrontmatter returns { meta: {}, content: raw } — getPlan spreads meta
    // (empty) and attaches content. Callers should not receive a thrown error.
    const id = crypto.randomUUID();
    writeMdFile(`${id}.md`, [
      "# No frontmatter here",
      "Just raw markdown.",
    ].join("\n"));

    let result: any;
    expect(() => {
      result = getPlan(id);
    }).not.toThrow();

    // The returned object has content but no id (since meta is empty).
    expect(result).not.toBeNull();
    expect(result.content).toContain("No frontmatter here");
    expect(result.id).toBeUndefined();
  });
});
