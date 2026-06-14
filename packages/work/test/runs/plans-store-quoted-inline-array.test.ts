/**
 * Focused test: parseFrontmatter strips surrounding quotes from inline array items.
 *
 * The `parseFrontmatter` function (plans-store.ts line ~75) maps each item in an
 * inline array through:
 *
 *   s.trim().replace(/^['"]|['"]$/g, "")
 *
 * This lets hand-authored plan files use either form:
 *
 *   tags: ['alpha', 'beta']          ← single-quoted
 *   tags: ["alpha", "beta"]          ← double-quoted
 *   tags: [alpha, beta]              ← unquoted (still valid)
 *
 * The serializer (serializeFrontmatter) never produces quoted inline items —
 * non-empty arrays are written as multi-line dash syntax, and empty arrays as
 * `key: []`.  So this quote-stripping path is ONLY reachable via hand-crafted
 * or externally-authored `.md` files, and was therefore never exercised by any
 * existing test that works through createPlan/getPlan.
 *
 * All tests inject raw `.md` files directly to disk and read them back via
 * getPlan / listPlans so that parseFrontmatter is exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { getPlan, listPlans } from "@zana-ai/work/src/runs/plans-store.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-quoted-${process.pid}`,
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

/** Write a minimal plan .md file with arbitrary frontmatter lines injected. */
function writePlanFile(id: string, extraFmLines: string[]): void {
  const baseFm = [
    `id: ${id}`,
    `title: "Quoted array test"`,
    `status: draft`,
    `createdBy: tester`,
    `createdAt: 2026-01-01T00:00:00.000Z`,
    `updatedAt: 2026-01-01T00:00:00.000Z`,
  ];
  const content = [
    "---",
    ...baseFm,
    ...extraFmLines,
    "---",
    "",
    "body text",
  ].join("\n");
  fs.writeFileSync(path.join(plansDir, `${id}.md`), content, "utf8");
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — inline array with single-quoted items", () => {
  it("strips surrounding single quotes from each item", () => {
    const id = crypto.randomUUID();
    writePlanFile(id, ["tags: ['alpha', 'beta', 'gamma']"]);

    const plan = getPlan(id);
    expect(plan).not.toBeNull();
    expect(Array.isArray(plan!.tags)).toBe(true);
    expect(plan!.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips quotes from a single-item inline array", () => {
    const id = crypto.randomUUID();
    writePlanFile(id, ["tags: ['only-one']"]);

    const plan = getPlan(id);
    expect(plan!.tags).toEqual(["only-one"]);
  });
});

describe("parseFrontmatter — inline array with double-quoted items", () => {
  it("strips surrounding double quotes from each item", () => {
    const id = crypto.randomUUID();
    writePlanFile(id, [`linkedTickets: ["T-1", "T-2", "T-3"]`]);

    const plan = getPlan(id);
    expect(Array.isArray(plan!.linkedTickets)).toBe(true);
    expect(plan!.linkedTickets).toEqual(["T-1", "T-2", "T-3"]);
  });
});

describe("parseFrontmatter — mixed-quote inline array items", () => {
  it("handles items where some are quoted and some are not", () => {
    // The replace only touches the leading/trailing character — unquoted items
    // are passed through unchanged.
    const id = crypto.randomUUID();
    writePlanFile(id, ["tags: [bare, 'single', \"double\"]"]);

    const plan = getPlan(id);
    expect(Array.isArray(plan!.tags)).toBe(true);
    expect(plan!.tags).toEqual(["bare", "single", "double"]);
  });
});

describe("parseFrontmatter — inline array items with extra whitespace", () => {
  it("trims whitespace before stripping quotes", () => {
    // The map does `.trim()` before the quote-strip, so `  'foo'  ` → `foo`.
    const id = crypto.randomUUID();
    writePlanFile(id, ["tags: [  'foo'  ,  'bar'  ]"]);

    const plan = getPlan(id);
    expect(plan!.tags).toEqual(["foo", "bar"]);
  });
});

describe("parseFrontmatter — inline array appears in listPlans metadata", () => {
  it("listPlans surfaces correctly parsed tags from a quoted inline array", () => {
    const id = crypto.randomUUID();
    writePlanFile(id, ["tags: ['security', 'review']"]);

    const results = listPlans({ tag: "security" } as any);
    const match = results.find((p: any) => p.id === id);
    expect(match).toBeDefined();
    expect(Array.isArray(match!.tags)).toBe(true);
    expect(match!.tags).toContain("security");
    expect(match!.tags).toContain("review");
  });
});
