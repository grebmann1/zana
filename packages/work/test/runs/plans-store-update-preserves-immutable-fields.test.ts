/**
 * Focused test: updatePlan preserves immutable + unspecified frontmatter fields.
 *
 * updatePlan (plans-store.ts) reads the existing plan, splits off `content`,
 * then applies ONLY the fields present in `updates` (title/status/linkedTickets/
 * tags) and bumps `updatedAt`. The documented invariant is therefore:
 *
 *   - `id`, `createdBy`, and `createdAt` are NEVER mutated by an update, and
 *   - a field omitted from `updates` (e.g. `tags` when only `status` is changed)
 *     survives unchanged rather than being reset to a default.
 *
 * The existing plans-store.test.ts "updatePlan mutates title, status, and
 * content" case only asserts on the fields it changes — it never pins that the
 * untouched/immutable fields are carried through. A regression that wiped
 * `createdBy`/`createdAt` or reset `tags` on every update would slip past the
 * current suite, so this guards that boundary explicitly.
 *
 * Deterministic: writes are confined to a per-test tmpdir; no clock injection
 * is needed because the assertions on createdAt/updatedAt only compare equality
 * and monotonicity, not absolute values.
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
  `zana-test-plans-update-immutable-${process.pid}`,
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

describe("plans-store updatePlan — preserves immutable & unspecified fields", () => {
  it("keeps id, createdBy, and createdAt unchanged when status is updated", () => {
    const plan = createPlan({
      title: "Original",
      content: "body",
      createdBy: "author-1",
      linkedTickets: ["T-1"],
      tags: ["alpha", "beta"],
    });

    const updated = updatePlan(plan.id, { status: "approved" });

    expect(updated).not.toBeNull();
    // Immutable identity/provenance fields must survive the update verbatim.
    expect(updated!.id).toBe(plan.id);
    expect(updated!.createdBy).toBe("author-1");
    expect(updated!.createdAt).toBe(plan.createdAt);
    // The requested change is applied.
    expect(updated!.status).toBe("approved");
  });

  it("does not reset tags or linkedTickets when they are omitted from updates", () => {
    const plan = createPlan({
      title: "Original",
      content: "body",
      createdBy: "author-1",
      linkedTickets: ["T-1", "T-2"],
      tags: ["alpha", "beta"],
    });

    // Update only the title — tags and linkedTickets are absent from `updates`.
    updatePlan(plan.id, { title: "Renamed" });

    const reloaded = getPlan(plan.id);
    expect(reloaded!.title).toBe("Renamed");
    expect(reloaded!.tags).toEqual(["alpha", "beta"]);
    expect(reloaded!.linkedTickets).toEqual(["T-1", "T-2"]);
    // Provenance untouched after a round-trip through serialize/parse.
    expect(reloaded!.createdBy).toBe("author-1");
    expect(reloaded!.createdAt).toBe(plan.createdAt);
  });
});
