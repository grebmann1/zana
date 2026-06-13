// Tests for db.ts listTickets combined filter paths.
//
// db-list-filters.test.ts covers each filter dimension in isolation.  This
// file exercises the case where `label` (which triggers a json_each SQL
// rewrite) is combined with another filter such as `status`.  The rewrite
// replaces the base SELECT clause via str.replace(); this only works correctly
// if the original "SELECT * FROM tickets WHERE 1=1" substring is still present
// when the label branch runs — even after prior conditions have been appended.
// Without a combined-filter test that invariant is invisible.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

// ── workspace bootstrap ────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-combined-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── helpers ────────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `dbc-${Date.now()}-${++seq}`; }

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${uid()}`,
    title: "Combined filter test ticket",
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

// ── label + status combined filter ─────────────────────────────────────────
//
// When both `label` and `status` are provided, the SQL rewrite path must
// still succeed even though `status` has already appended "AND status = ?"
// to the query before the label branch runs.

describe("listTickets — label combined with status filter", () => {
  it("returns only tickets matching BOTH label and status", () => {
    const match        = makeTicket({ labels: ["bug"], status: "in-progress" });
    const wrongStatus  = makeTicket({ labels: ["bug"], status: "backlog" });
    const wrongLabel   = makeTicket({ labels: ["feature"], status: "in-progress" });
    const neither      = makeTicket({ labels: [], status: "done" });

    db.saveTicket(match);
    db.saveTicket(wrongStatus);
    db.saveTicket(wrongLabel);
    db.saveTicket(neither);

    const results = db.listTickets({ label: "bug", status: "in-progress" });
    const ids = results.map((t: any) => t.id);

    expect(ids).toContain(match.id);
    expect(ids).not.toContain(wrongStatus.id);
    expect(ids).not.toContain(wrongLabel.id);
    expect(ids).not.toContain(neither.id);
  });

  it("returns empty array when no ticket satisfies both constraints", () => {
    // Use a label that exists (on a backlog ticket) but not on any in-review ticket.
    const backlogBug = makeTicket({ labels: ["regression"], status: "backlog" });
    db.saveTicket(backlogBug);

    const results = db.listTickets({ label: "regression", status: "review" });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});

// ── label + assigneeId combined filter ─────────────────────────────────────

describe("listTickets — label combined with assigneeId filter", () => {
  it("returns only tickets matching BOTH label and assigneeId", () => {
    const agentId = `agent-${uid()}`;
    const match       = makeTicket({ labels: ["urgent"], assigneeId: agentId });
    const wrongAgent  = makeTicket({ labels: ["urgent"], assigneeId: "other-agent" });
    const noLabel     = makeTicket({ labels: [], assigneeId: agentId });

    db.saveTicket(match);
    db.saveTicket(wrongAgent);
    db.saveTicket(noLabel);

    const results = db.listTickets({ label: "urgent", assigneeId: agentId });
    const ids = results.map((t: any) => t.id);

    expect(ids).toContain(match.id);
    expect(ids).not.toContain(wrongAgent.id);
    expect(ids).not.toContain(noLabel.id);
  });
});
