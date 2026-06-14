/**
 * Focused test: parseFrontmatter handles Windows-style CRLF line endings.
 *
 * The internal parseFrontmatter function uses /\r?\n/ throughout so that
 * plan files authored or cloned on Windows (which end lines with \r\n) are
 * parsed correctly.  This path is NOT exercised by createPlan (which always
 * writes LF), so we inject a hand-crafted CRLF file directly to disk and
 * read it back via getPlan / listPlans.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { getPlan, listPlans } from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-crlf-${process.pid}`,
);

/** Write a plan .md file using CRLF line endings directly to disk. */
function writeCrlfPlan(plansDir: string, id: string, overrides: Record<string, string> = {}) {
  const defaults = {
    id,
    title: "CRLF Plan",
    status: "draft",
    createdBy: "tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedTickets: "[]",
    tags: "[]",
  };
  const fields = { ...defaults, ...overrides };

  // Build frontmatter lines joined with CRLF
  const fmLines = [
    `id: ${fields.id}`,
    `title: "${fields.title}"`,
    `status: ${fields.status}`,
    `createdBy: ${fields.createdBy}`,
    `createdAt: ${fields.createdAt}`,
    `updatedAt: ${fields.updatedAt}`,
    `linkedTickets: ${fields.linkedTickets}`,
    `tags: ${fields.tags}`,
  ];

  const crlf = "\r\n";
  const fileContent =
    `---${crlf}` +
    fmLines.join(crlf) +
    `${crlf}---${crlf}${crlf}` +
    `Plan body text.${crlf}`;

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${id}.md`), fileContent, "utf8");
}

describe("plans-store — CRLF (Windows) line endings in frontmatter", () => {
  let plansDir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
    plansDir = workspaceContext.getProjectPaths().plansDir;
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("getPlan parses scalar frontmatter fields from a CRLF file", () => {
    const id = crypto.randomUUID();
    writeCrlfPlan(plansDir, id);

    const plan = getPlan(id);
    expect(plan).not.toBeNull();
    expect(plan!.id).toBe(id);
    expect(plan!.title).toBe("CRLF Plan");
    expect(plan!.status).toBe("draft");
    expect(plan!.createdBy).toBe("tester");
  });

  it("getPlan returns the body content from a CRLF file", () => {
    const id = crypto.randomUUID();
    writeCrlfPlan(plansDir, id);

    const plan = getPlan(id);
    // Content after the closing --- delimiter should be non-empty
    expect(plan!.content).toContain("Plan body text.");
  });

  it("getPlan parses inline empty-array fields from a CRLF file", () => {
    const id = crypto.randomUUID();
    writeCrlfPlan(plansDir, id, { tags: "[]", linkedTickets: "[]" });

    const plan = getPlan(id);
    expect(Array.isArray(plan!.tags)).toBe(true);
    expect((plan!.tags as string[]).length).toBe(0);
    expect(Array.isArray(plan!.linkedTickets)).toBe(true);
  });

  it("listPlans includes CRLF-encoded plans and returns correct metadata", () => {
    const id = crypto.randomUUID();
    writeCrlfPlan(plansDir, id, { status: "approved" });

    const plans = listPlans({ status: "approved" } as any);
    expect(plans.some((p: any) => p.id === id)).toBe(true);
  });

  it("getPlan parses multi-line dash-array from a CRLF file", () => {
    const id = crypto.randomUUID();
    // Build a CRLF file with multi-line tag array
    const crlf = "\r\n";
    const fmLines = [
      `id: ${id}`,
      `title: "Tagged CRLF"`,
      `status: draft`,
      `createdBy: tester`,
      `createdAt: 2026-01-01T00:00:00.000Z`,
      `updatedAt: 2026-01-01T00:00:00.000Z`,
      `linkedTickets: []`,
      `tags:`,
      `  - alpha`,
      `  - beta`,
    ];
    const fileContent =
      `---${crlf}` +
      fmLines.join(crlf) +
      `${crlf}---${crlf}${crlf}body${crlf}`;

    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, `${id}.md`), fileContent, "utf8");

    const plan = getPlan(id);
    expect(plan).not.toBeNull();
    expect(Array.isArray(plan!.tags)).toBe(true);
    expect(plan!.tags).toEqual(["alpha", "beta"]);
  });
});
