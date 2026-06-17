/**
 * Focused test for the `linkedTickets` update branch in plans-store.updatePlan.
 *
 * service/runs plans-store.ts line 231:
 *   if (updates.linkedTickets !== undefined) existingMeta.linkedTickets = updates.linkedTickets;
 *
 * The existing array-roundtrip suite exercises updatePlan ONLY for `tags`
 * (plans-store-array-roundtrip.test.ts: "updatePlan replacing tags ..."). The
 * sibling `linkedTickets` branch — a distinct field that serializes as a
 * multi-line dash array and must parse back into a JS array on the next
 * getPlan — is never asserted. This file pins that branch so a refactor that
 * drops or mishandles the linkedTickets update is caught.
 *
 * Deterministic: real fs under a unique tmp dir, real workspace-context init,
 * no network, no mocks.
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
  `zana-test-plans-linked-${Date.now()}-${process.pid}`
);

describe("plans-store — updatePlan replaces linkedTickets", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("replaces a multi-element linkedTickets array and round-trips it via getPlan", () => {
    const plan = createPlan({
      title: "Linkable",
      content: "body",
      createdBy: "u",
      linkedTickets: ["T-1"],
      tags: [],
    });

    const updated = updatePlan(plan.id, { linkedTickets: ["T-2", "T-3", "T-4"] });

    // The returned record reflects the new array (order + count preserved).
    expect(updated).not.toBeNull();
    expect(updated!.linkedTickets).toEqual(["T-2", "T-3", "T-4"]);

    // And it survives the serialize → parse round-trip on a fresh read.
    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(Array.isArray(fetched!.linkedTickets)).toBe(true);
    expect(fetched!.linkedTickets).toEqual(["T-2", "T-3", "T-4"]);

    // The unrelated `tags` field is untouched by a linkedTickets-only update.
    expect(fetched!.tags).toEqual([]);
  });

  it("clears linkedTickets to an empty array when updated to []", () => {
    const plan = createPlan({
      title: "Clearable",
      content: "",
      createdBy: "u",
      linkedTickets: ["T-9", "T-10"],
      tags: [],
    });

    updatePlan(plan.id, { linkedTickets: [] });

    const fetched = getPlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(Array.isArray(fetched!.linkedTickets)).toBe(true);
    expect(fetched!.linkedTickets).toEqual([]);
  });
});
