/**
 * Focused round-trip tests for parseFrontmatter array handling in plans-store.
 *
 * The serializer writes:
 *   - empty arrays  → inline  `key: []`
 *   - non-empty     → multi-line dash syntax
 *
 * parseFrontmatter must decode both forms back into JS arrays. No existing test
 * calls getPlan and asserts the shape of `linkedTickets` / `tags` fields.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import {
  createPlan,
  getPlan,
  updatePlan,
} from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-array-${Date.now()}-${process.pid}`
);

describe("plans-store — frontmatter array round-trip", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("getPlan returns tags as a JS array when non-empty", () => {
    const plan = createPlan({
      title: "With tags",
      content: "body",
      createdBy: "u",
      linkedTickets: [],
      tags: ["alpha", "beta"],
    });
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(Array.isArray(fetched!.tags)).toBe(true);
    expect(fetched!.tags).toEqual(["alpha", "beta"]);
  });

  it("getPlan returns linkedTickets as a JS array when non-empty", () => {
    const plan = createPlan({
      title: "With tickets",
      content: "",
      createdBy: "u",
      linkedTickets: ["T-abc", "T-xyz"],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(Array.isArray(fetched!.linkedTickets)).toBe(true);
    expect(fetched!.linkedTickets).toEqual(["T-abc", "T-xyz"]);
  });

  it("getPlan returns empty array for tags: [] (inline serialization)", () => {
    const plan = createPlan({
      title: "No tags",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    // serializeFrontmatter writes `tags: []`; parseFrontmatter must decode it as []
    expect(Array.isArray(fetched!.tags)).toBe(true);
    expect(fetched!.tags).toEqual([]);
  });

  it("getPlan returns empty array for linkedTickets: [] (inline serialization)", () => {
    const plan = createPlan({
      title: "No tickets",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: [],
    });
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(Array.isArray(fetched!.linkedTickets)).toBe(true);
    expect(fetched!.linkedTickets).toEqual([]);
  });

  it("updatePlan replacing tags preserves array type on next getPlan", () => {
    const plan = createPlan({
      title: "Updatable",
      content: "",
      createdBy: "u",
      linkedTickets: [],
      tags: ["old"],
    });
    updatePlan(plan.id, { tags: ["new-tag", "another"] });
    const fetched = getPlan(plan.id);
    expect(Array.isArray(fetched!.tags)).toBe(true);
    expect(fetched!.tags).toEqual(["new-tag", "another"]);
  });
});
