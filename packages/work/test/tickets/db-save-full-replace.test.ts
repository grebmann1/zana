// Tests for db.ts saveTicket() write semantics.
//
// db.test.ts covers basic CRUD and an upsert that only mutates `title`. It
// never pins the fact that _saveTicket uses `INSERT OR REPLACE` — a full-row
// REPLACE, not a column-level merge. Re-saving a ticket WITHOUT a field that
// was previously set must therefore CLEAR that field back to its default, not
// retain the old value. A regression that switched to a partial UPDATE (or a
// COALESCE-style merge) would silently keep stale assignee/sprint/label data
// and slip past every existing test.
//
// Also pins that a non-zero reworkCount survives the round-trip as a real
// integer — the `reworkCount || 0` fallback in rowToTicket must not collapse a
// genuine count to 0.
//
// Deterministic: SQLite in a per-test temp workspace, no network, no daemon.

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-replace-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── factory ──────────────────────────────────────────────────────────────

let seq = 0;
const PREFIX = "dbr"; // "db replace" — avoids id collisions with sibling suites
function uid() { return `${PREFIX}-${Date.now()}-${++seq}`; }

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${uid()}`,
    title: "Replace test ticket",
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

// ── full-row replace semantics ─────────────────────────────────────────────

describe("db.saveTicket — INSERT OR REPLACE full-row semantics", () => {
  it("re-saving without previously-set optional fields clears them (replace, not merge)", () => {
    const t = makeTicket({
      assigneeId: "agent-alice",
      assigneeName: "Alice",
      sprintId: "S-old",
      labels: ["bug", "urgent"],
    });
    db.saveTicket(t);

    // Sanity: the first save persisted the optional fields.
    const first = db.getTicket(t.id);
    expect(first!.assigneeId).toBe("agent-alice");
    expect(first!.sprintId).toBe("S-old");
    expect(first!.labels).toEqual(["bug", "urgent"]);

    // Re-save the SAME id with a bare ticket that omits those fields.
    db.saveTicket(makeTicket({ id: t.id, title: "Re-saved bare" }));

    const got = db.getTicket(t.id);
    expect(got!.title).toBe("Re-saved bare");
    // Full-row REPLACE → omitted optional fields revert to defaults, not stale values.
    expect(got!.assigneeId).toBeNull();
    expect(got!.assigneeName).toBeNull();
    expect(got!.sprintId).toBeNull();
    expect(got!.labels).toEqual([]);
  });

  it("persists a non-zero reworkCount as a real integer (no collapse to 0)", () => {
    const t = makeTicket({ reworkCount: 3 });
    db.saveTicket(t);
    const got = db.getTicket(t.id);
    expect(got!.reworkCount).toBe(3);
  });
});
