/**
 * Focused test: createPlan / getPlan round-trip for titles containing
 * YAML-special characters.
 *
 * serializeFrontmatter (plans-store.ts) guards the title field specifically:
 *
 *   if (key === "title" && value) {
 *     lines.push(`${key}: "${value}"`);
 *   }
 *
 * Wrapping in double quotes lets the title contain colons, hash signs, and
 * other characters that YAML would otherwise misinterpret as structure.
 *
 * parseFrontmatter strips only the LEADING and TRAILING quote character
 * (`value.replace(/^['"]|['"]$/g, "")`), so embedded double-quotes survive
 * the round-trip — e.g. `"Handle \"edge\" case"` round-trips to
 * `Handle "edge" case`.
 *
 * None of the existing plans-store test files exercise a title that contains
 * these characters; all existing tests use plain alphanumeric titles.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  createPlan,
  getPlan,
  listPlans,
  updatePlan,
} from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-title-special-${process.pid}`,
);

beforeEach(() => {
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe("plans-store — title round-trip with YAML-special characters", () => {
  it("title containing a colon survives createPlan → getPlan round-trip", () => {
    // The YAML parser would interpret an unquoted colon as a key/value separator.
    // serializeFrontmatter double-quotes the title to prevent that.
    const plan = createPlan({
      title: "Fix bug: handle null edge case",
      content: "body",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Fix bug: handle null edge case");
  });

  it("title containing multiple colons survives round-trip", () => {
    const plan = createPlan({
      title: "Phase 1: Design: Architecture",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched!.title).toBe("Phase 1: Design: Architecture");
  });

  it("title containing embedded double-quotes survives round-trip", () => {
    // parseFrontmatter strips only the FIRST and LAST quote character, so
    // embedded quotes survive — `"Handle "edge" case"` → `Handle "edge" case`.
    const plan = createPlan({
      title: 'Handle "edge" case',
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched!.title).toBe('Handle "edge" case');
  });

  it("title containing a leading hash (YAML comment char) survives round-trip", () => {
    // An unquoted `# …` at the start of a YAML value is treated as a comment.
    const plan = createPlan({
      title: "# 42: the answer",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched!.title).toBe("# 42: the answer");
  });

  it("title containing a colon appears correctly in listPlans metadata", () => {
    const plan = createPlan({
      title: "Sprint 3: auth module",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const plans = listPlans();
    const match = plans.find((p: any) => p.id === plan.id);
    expect(match).toBeDefined();
    expect(match!.title).toBe("Sprint 3: auth module");
  });

  it("updatePlan preserves a colon-containing title across serialise/parse cycles", () => {
    const plan = createPlan({
      title: "Initial: Draft",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    // Updating content should not corrupt the existing colon-title.
    updatePlan(plan.id, { content: "revised body" });
    const fetched = getPlan(plan.id);
    expect(fetched!.title).toBe("Initial: Draft");
    expect(fetched!.content.trim()).toBe("revised body");
  });
});
