// Tests for db.ts workRef serialization in _saveTicket / rowToTicket.
//
// workRef is a small JSON object ({ branch?, commitRange?, worktree? }) or
// null. db.ts has two documented invariants that no existing suite pins:
//   1. A workRef object round-trips through SQLite as a deep-equal object,
//      and an absent workRef reads back as null (not "null", not undefined).
//   2. rowToTicket tolerates a legacy/corrupt stored value by falling back to
//      null rather than throwing on read (db.ts:103).
//
// A regression that dropped the JSON.stringify on write, or removed the
// try/catch on read, would slip past every current test. We exercise the
// corrupt path by writing invalid JSON straight into the column via a second
// SQLite connection, then asserting getTicket() returns null without throwing.
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
let dbPath: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-workref-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
  const projectDir = (core as any).project.workspaceContext.getProjectDir();
  dbPath = path.join(projectDir, "tickets.db");
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── factory ──────────────────────────────────────────────────────────────

let seq = 0;
function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-wref-${++seq}`,
    title: "workRef test ticket",
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

describe("db workRef serialization", () => {
  it("round-trips a workRef object as a deep-equal object", () => {
    const workRef = { branch: "feat/x", commitRange: "abc..def", worktree: "/tmp/wt" };
    const t = makeTicket({ id: "T-wref-obj", workRef });
    db.saveTicket(t);

    const got = db.getTicket("T-wref-obj");
    expect(got!.workRef).toEqual(workRef);
    // Stored as text but rehydrated as a real object, not the raw JSON string.
    expect(typeof got!.workRef).toBe("object");
  });

  it("reads back null when workRef is absent (not undefined or 'null')", () => {
    const t = makeTicket({ id: "T-wref-absent" });
    db.saveTicket(t);

    const got = db.getTicket("T-wref-absent");
    expect(got!.workRef).toBeNull();
  });

  it("falls back to null on a corrupt/legacy workRef value instead of throwing", () => {
    const t = makeTicket({ id: "T-wref-corrupt" });
    db.saveTicket(t);

    // Inject an un-parseable value straight into the column via a second
    // connection, simulating a legacy/corrupt row.
    const Database = require("better-sqlite3");
    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE tickets SET workRef = ? WHERE id = ?").run("{not valid json", "T-wref-corrupt");
    } finally {
      raw.close();
    }

    let got: any;
    expect(() => { got = db.getTicket("T-wref-corrupt"); }).not.toThrow();
    expect(got.workRef).toBeNull();
  });
});
