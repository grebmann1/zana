import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as artifactStore from "@zana-ai/work/src/runs/artifact-store.ts";
import * as core from "@zana-ai/core";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-artifact-crud-${Date.now()}-${process.pid}`
);

describe("artifact-store CRUD", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  // ── createArtifact / getArtifact ──────────────────────────────────────────

  it("createArtifact persists defaults and getArtifact round-trips it", () => {
    const rec = artifactStore.createArtifact({ id: "art-1", title: "Hello", content: "world", type: "note" });
    expect(rec.id).toBe("art-1");
    expect(rec.title).toBe("Hello");
    expect(rec.content).toBe("world");
    expect(rec.type).toBe("note");
    expect(rec.tags).toEqual([]);
    expect(rec.linkedTickets).toEqual([]);
    expect(typeof rec.createdAt).toBe("string");
    expect(rec.createdAt).toBe(rec.updatedAt);

    const fetched = artifactStore.getArtifact("art-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("art-1");
    expect(fetched!.content).toBe("world");
  });

  it("getArtifact returns null for a non-existent id", () => {
    expect(artifactStore.getArtifact("no-such-artifact")).toBeNull();
  });

  it("getArtifact returns null for null/empty id", () => {
    expect(artifactStore.getArtifact(null as any)).toBeNull();
    expect(artifactStore.getArtifact("")).toBeNull();
  });

  // ── listArtifacts ─────────────────────────────────────────────────────────

  it("listArtifacts returns all artifacts when no filter given", () => {
    artifactStore.createArtifact({ id: "l-1", title: "A" });
    artifactStore.createArtifact({ id: "l-2", title: "B" });
    const list = artifactStore.listArtifacts();
    const ids = list.map((a) => a.id);
    expect(ids).toContain("l-1");
    expect(ids).toContain("l-2");
  });

  it("listArtifacts returns [] for an empty store", () => {
    expect(artifactStore.listArtifacts()).toEqual([]);
  });

  it("listArtifacts filters by type", () => {
    artifactStore.createArtifact({ id: "t-note", title: "N", type: "note" });
    artifactStore.createArtifact({ id: "t-code", title: "C", type: "code" });
    const notes = artifactStore.listArtifacts({ type: "note" });
    expect(notes.every((a) => a.type === "note")).toBe(true);
    const ids = notes.map((a) => a.id);
    expect(ids).toContain("t-note");
    expect(ids).not.toContain("t-code");
  });

  it("listArtifacts filters by tag", () => {
    artifactStore.createArtifact({ id: "tag-a", title: "A", tags: ["alpha", "shared"] });
    artifactStore.createArtifact({ id: "tag-b", title: "B", tags: ["beta"] });
    artifactStore.createArtifact({ id: "tag-c", title: "C", tags: ["shared"] });
    const shared = artifactStore.listArtifacts({ tag: "shared" });
    const ids = shared.map((a) => a.id);
    expect(ids).toContain("tag-a");
    expect(ids).toContain("tag-c");
    expect(ids).not.toContain("tag-b");
  });

  it("listArtifacts omits content field (summary-only projection)", () => {
    artifactStore.createArtifact({ id: "proj-1", title: "T", content: "secret-content" });
    const list = artifactStore.listArtifacts();
    const item = list.find((a) => a.id === "proj-1");
    expect(item).toBeDefined();
    expect((item as any).content).toBeUndefined();
  });

  it("listArtifacts silently skips corrupted JSON files", () => {
    artifactStore.createArtifact({ id: "good", title: "OK" });
    // Manually drop a corrupt JSON file in the artifacts dir
    const artDir = workspaceContext.getProjectPaths().artifactsDir;
    fs.writeFileSync(path.join(artDir, "corrupt.json"), "{ not valid json {{");
    const list = artifactStore.listArtifacts();
    // Corrupt entry omitted; valid entry still present
    const ids = list.map((a) => a.id);
    expect(ids).toContain("good");
    expect(ids).not.toContain("corrupt");
  });

  // ── updateArtifact ────────────────────────────────────────────────────────

  it("updateArtifact patches title, content, tags, linkedTickets and bumps updatedAt", () => {
    const orig = artifactStore.createArtifact({ id: "u-1", title: "Old", content: "v1", tags: [] });
    const updated = artifactStore.updateArtifact("u-1", {
      title: "New",
      content: "v2",
      tags: ["foo"],
      linkedTickets: ["T-99"],
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("New");
    expect(updated!.content).toBe("v2");
    expect(updated!.tags).toEqual(["foo"]);
    expect(updated!.linkedTickets).toEqual(["T-99"]);
    expect(updated!.updatedAt >= orig.createdAt).toBe(true);
  });

  it("updateArtifact returns null for a non-existent artifact", () => {
    expect(artifactStore.updateArtifact("ghost", { title: "X" })).toBeNull();
  });

  it("updateArtifact persists changes (verified via getArtifact)", () => {
    artifactStore.createArtifact({ id: "u-2", title: "Before", content: "old" });
    artifactStore.updateArtifact("u-2", { content: "new" });
    const fetched = artifactStore.getArtifact("u-2");
    expect(fetched!.content).toBe("new");
    expect(fetched!.title).toBe("Before"); // untouched field preserved
  });

  // ── deleteArtifact ────────────────────────────────────────────────────────

  it("deleteArtifact removes the artifact and returns true", () => {
    artifactStore.createArtifact({ id: "del-1", title: "Bye" });
    expect(artifactStore.deleteArtifact("del-1")).toBe(true);
    expect(artifactStore.getArtifact("del-1")).toBeNull();
  });

  it("deleteArtifact returns false for a non-existent id", () => {
    expect(artifactStore.deleteArtifact("no-such")).toBe(false);
  });

  it("deleteArtifact returns false for null/empty id", () => {
    expect(artifactStore.deleteArtifact(null as any)).toBe(false);
    expect(artifactStore.deleteArtifact("")).toBe(false);
  });

  it("deleted artifact no longer appears in listArtifacts", () => {
    artifactStore.createArtifact({ id: "del-2", title: "Gone" });
    artifactStore.deleteArtifact("del-2");
    const ids = artifactStore.listArtifacts().map((a) => a.id);
    expect(ids).not.toContain("del-2");
  });
});
