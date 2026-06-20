// Tests for db.ts listTickets when the `label` json_each rewrite is combined
// with the `parentId` epic-children branch (ADR 0011).
//
// db-list-combined-filters.test.ts pins label+status and label+assigneeId, and
// db-parent-id.test.ts pins the parentId branch in isolation — but nothing
// exercises BOTH together. The parentId branch is special: it is the only
// filter that can append either "AND parentId = ?" (a child query) or
// "AND parentId IS NULL" (top-level/epic query), and it runs BEFORE the label
// branch performs its str.replace() rewrite of the base SELECT. If a regression
// reordered the branches so the rewrite ran first — or dropped the
// undefined-vs-null distinction — these combinations would silently return the
// wrong rows. Both cases are invisible without a combined test.
//
// Deterministic: SQLite in a per-test temp workspace, no network, no daemon.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

// ── workspace bootstrap ────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-label-parent-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── helpers ────────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `dblp-${Date.now()}-${++seq}`; }

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${uid()}`,
    title: "label+parent filter test ticket",
    status: "backlog",
    priority: "medium",
    labels: [] as string[],
    blockedBy: [] as string[],
    comments: [] as unknown[],
    audit: [] as unknown[],
    reworkCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── label + explicit parentId (epic children) ──────────────────────────────

describe("listTickets — label combined with a concrete parentId", () => {
  it("returns only children of the epic that also carry the label", () => {
    const epicId = `E-${uid()}`;
    const match       = makeTicket({ labels: ["bug"], parentId: epicId });
    const wrongParent = makeTicket({ labels: ["bug"], parentId: `other-${uid()}` });
    const wrongLabel  = makeTicket({ labels: ["feature"], parentId: epicId });
    const topLevelBug = makeTicket({ labels: ["bug"] }); // no parentId

    db.saveTicket(match);
    db.saveTicket(wrongParent);
    db.saveTicket(wrongLabel);
    db.saveTicket(topLevelBug);

    const results = db.listTickets({ label: "bug", parentId: epicId });
    const ids = results.map((t: any) => t.id);

    expect(ids).toContain(match.id);
    expect(ids).not.toContain(wrongParent.id);
    expect(ids).not.toContain(wrongLabel.id);
    expect(ids).not.toContain(topLevelBug.id);
  });
});

// ── label + parentId: null (top-level tickets only) ─────────────────────────
//
// parentId === null is a meaningful filter that emits "AND parentId IS NULL"
// (a distinct branch from a concrete id), and must be distinguishable from an
// omitted filter. Combined with the label rewrite, only top-level tickets
// carrying the label should match — never a labelled child.

describe("listTickets — label combined with parentId: null", () => {
  it("returns only top-level tickets that carry the label, excluding labelled children", () => {
    const epicId = `E-${uid()}`;
    const topLevelMatch = makeTicket({ labels: ["urgent"] });            // parentId omitted → null
    const childWithLabel = makeTicket({ labels: ["urgent"], parentId: epicId });
    const topLevelNoLabel = makeTicket({ labels: ["routine"] });

    db.saveTicket(topLevelMatch);
    db.saveTicket(childWithLabel);
    db.saveTicket(topLevelNoLabel);

    const results = db.listTickets({ label: "urgent", parentId: null });
    const ids = results.map((t: any) => t.id);

    expect(ids).toContain(topLevelMatch.id);
    expect(ids).not.toContain(childWithLabel.id);
    expect(ids).not.toContain(topLevelNoLabel.id);
  });
});
