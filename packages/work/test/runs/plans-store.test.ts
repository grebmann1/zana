import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import {
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
} from "@zana-ai/work/src/runs/plans-store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-plans-${Date.now()}-${process.pid}`
);

describe("plans-store CRUD", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  function plansDir() {
    return workspaceContext.getProjectPaths().plansDir;
  }

  // ── createPlan ──────────────────────────────────────────────────────────────

  it("createPlan returns a record with id, title, status=draft, and content", () => {
    const plan = createPlan({ title: "My Plan", content: "# heading", createdBy: "alice", linkedTickets: [], tags: [] });
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.title).toBe("My Plan");
    expect(plan.status).toBe("draft");
    expect(plan.content).toBe("# heading");
    expect(plan.createdBy).toBe("alice");
  });

  it("createPlan writes a .md file inside plansDir", () => {
    const plan = createPlan({ title: "Stored", content: "body", createdBy: "bot", linkedTickets: [], tags: [] });
    const filePath = path.join(plansDir(), `${plan.id}.md`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("createPlan with no title defaults to 'Untitled Plan'", () => {
    const plan = createPlan({ title: undefined, content: "", createdBy: "x", linkedTickets: [], tags: [] });
    expect(plan.title).toBe("Untitled Plan");
  });

  it("createPlan persists tags and linkedTickets in frontmatter", () => {
    const plan = createPlan({ title: "Tagged", content: "", createdBy: "bot", linkedTickets: ["T-1"], tags: ["arch"] });
    const raw = fs.readFileSync(path.join(plansDir(), `${plan.id}.md`), "utf8");
    expect(raw).toContain("T-1");
    expect(raw).toContain("arch");
  });

  // ── getPlan ─────────────────────────────────────────────────────────────────

  it("getPlan returns the full plan including content", () => {
    const created = createPlan({ title: "Readable", content: "hello world", createdBy: "r", linkedTickets: [], tags: [] });
    const fetched = getPlan(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Readable");
    // getPlan returns content with surrounding newlines from the Markdown file
    expect(fetched!.content.trim()).toBe("hello world");
  });

  it("getPlan returns null for an unknown id", () => {
    expect(getPlan("does-not-exist")).toBeNull();
  });

  it("getPlan returns null for null/empty id", () => {
    expect(getPlan(null as any)).toBeNull();
    expect(getPlan("")).toBeNull();
  });

  // ── updatePlan ──────────────────────────────────────────────────────────────

  it("updatePlan mutates title, status, and content; bumps updatedAt", async () => {
    const plan = createPlan({ title: "Old", content: "v1", createdBy: "u", linkedTickets: [], tags: [] });
    const originalUpdatedAt = plan.updatedAt;
    // Brief pause to ensure timestamp advances
    await new Promise((r) => setTimeout(r, 5));
    const updated = updatePlan(plan.id, { title: "New", status: "approved", content: "v2" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("New");
    expect(updated!.status).toBe("approved");
    expect(updated!.content).toBe("v2");
    expect(updated!.updatedAt >= originalUpdatedAt).toBe(true);
  });

  it("updatePlan persists changes so getPlan returns new values", () => {
    const plan = createPlan({ title: "P", content: "old", createdBy: "u", linkedTickets: [], tags: [] });
    updatePlan(plan.id, { content: "new content" });
    const reloaded = getPlan(plan.id);
    expect(reloaded!.content.trim()).toBe("new content");
  });

  it("updatePlan returns null for a non-existent id", () => {
    expect(updatePlan("ghost-id", { title: "x" })).toBeNull();
  });

  // ── deletePlan ──────────────────────────────────────────────────────────────

  it("deletePlan removes the .md file and returns true", () => {
    const plan = createPlan({ title: "Del", content: "", createdBy: "u", linkedTickets: [], tags: [] });
    const filePath = path.join(plansDir(), `${plan.id}.md`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(deletePlan(plan.id)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deletePlan returns false for a non-existent id", () => {
    expect(deletePlan("no-such-plan")).toBe(false);
  });

  it("deletePlan returns false for a null id", () => {
    expect(deletePlan(null as any)).toBe(false);
  });

  // ── listPlans ───────────────────────────────────────────────────────────────

  it("listPlans returns all created plans sorted newest-first", () => {
    // Use fake timers so A and B get distinct ISO timestamps; without this
    // both calls land in the same millisecond and the sort is a no-op.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      createPlan({ title: "A", content: "", createdBy: "u", linkedTickets: [], tags: [] });
      vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));
      createPlan({ title: "B", content: "", createdBy: "u", linkedTickets: [], tags: [] });
    } finally {
      vi.useRealTimers();
    }
    const plans = listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(2);
    // Sorted descending — last created should be first
    const titles = plans.map((p) => p.title);
    expect(titles.indexOf("B")).toBeLessThan(titles.indexOf("A"));
  });

  it("listPlans filters by status", () => {
    const p1 = createPlan({ title: "Draft", content: "", createdBy: "u", linkedTickets: [], tags: [] });
    updatePlan(p1.id, { status: "approved" });
    createPlan({ title: "StillDraft", content: "", createdBy: "u", linkedTickets: [], tags: [] });

    const approved = listPlans({ status: "approved" } as any);
    expect(approved.every((p) => p.status === "approved")).toBe(true);

    const drafts = listPlans({ status: "draft" } as any);
    expect(drafts.every((p) => p.status === "draft")).toBe(true);
  });

  it("listPlans filters by tag", () => {
    createPlan({ title: "Tagged", content: "", createdBy: "u", linkedTickets: [], tags: ["security"] });
    createPlan({ title: "NoTag", content: "", createdBy: "u", linkedTickets: [], tags: [] });

    const results = listPlans({ tag: "security" } as any);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((p) => Array.isArray(p.tags) && p.tags.includes("security"))).toBe(true);
  });

  it("listPlans returns empty array when no plans exist", () => {
    // Fresh workspace — no plans written yet
    expect(listPlans()).toEqual([]);
  });
});

describe("plans-store tenant-isolation gate", () => {
  // This describe deliberately does NOT bootstrap a workspace; it asserts
  // that createPlan refuses to write into the global ~/.zana/plans fallback.
  beforeEach(() => {
    try { (workspaceContext as any)._resetForTesting?.(); } catch {}
    try { (core as any).project.workspaceContext._resetForTesting?.(); } catch {}
  });

  it("createPlan throws WorkspaceNotInitializedError when workspace not initialized", () => {
    const wcDist: any = (core as any).project.workspaceContext;
    const ErrCtor = wcDist.WorkspaceNotInitializedError;
    expect(wcDist.isInitialized()).toBe(false);
    let caught: any = null;
    try {
      createPlan({ title: "blocked", content: "x", createdBy: "u", linkedTickets: [], tags: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ErrCtor);
    expect(caught.code).toBe("WORKSPACE_NOT_INITIALIZED");
  });
});
