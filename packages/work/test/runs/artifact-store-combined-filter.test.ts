// listArtifacts — combined type+tag filter (AND logic).
//
// artifact-store.ts applies filter.type and filter.tag sequentially:
//
//   if (filter.type) artifacts = artifacts.filter(a => a.type === filter.type);
//   if (filter.tag)  artifacts = artifacts.filter(a => a.tags?.includes(filter.tag));
//
// Every existing test exercises each filter in isolation. The path where BOTH
// are set — producing an AND intersection — has never been reached by any test.
// A regression that turned it into OR logic would pass the existing tests
// undetected.
//
// This file pins the AND-intersection contract with a deterministic fixture.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-combined-filter-${Date.now()}-${process.pid}`,
);

describe("listArtifacts — combined type+tag filter (AND intersection)", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("returns only artifacts matching BOTH type and tag (AND, not OR)", () => {
    // Fixture: four artifacts covering every combination of type × tag presence.
    artifactStore.createArtifact({ id: "note-imp",  title: "Note+Important", type: "note", tags: ["important"] });
    artifactStore.createArtifact({ id: "code-imp",  title: "Code+Important", type: "code", tags: ["important"] });
    artifactStore.createArtifact({ id: "note-other",title: "Note+Other",     type: "note", tags: ["other"]     });
    artifactStore.createArtifact({ id: "code-other",title: "Code+Other",     type: "code", tags: ["other"]     });

    const results = artifactStore.listArtifacts({ type: "note", tag: "important" } as any);
    const ids = results.map((a) => a.id);

    // Only "note-imp" satisfies both predicates.
    expect(ids).toContain("note-imp");

    // Items that satisfy only ONE predicate must be excluded.
    expect(ids).not.toContain("code-imp");   // wrong type
    expect(ids).not.toContain("note-other"); // wrong tag
    expect(ids).not.toContain("code-other"); // wrong type AND wrong tag
  });

  it("returns empty array when no artifact matches both type and tag simultaneously", () => {
    // Two artifacts: one matches type, the other matches tag — but neither matches both.
    artifactStore.createArtifact({ id: "type-only", title: "TypeMatch", type: "note", tags: ["beta"] });
    artifactStore.createArtifact({ id: "tag-only",  title: "TagMatch",  type: "code", tags: ["alpha"] });

    const results = artifactStore.listArtifacts({ type: "note", tag: "alpha" } as any);
    expect(results).toHaveLength(0);
  });
});
