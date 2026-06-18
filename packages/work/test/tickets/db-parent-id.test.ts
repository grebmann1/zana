// Tests for db.ts parentId column (#4 epic/parent hierarchy):
//   1. parentId round-trips through SQLite (object → row → object).
//   2. An absent parentId reads back as null.
//   3. listTickets({ parentId }) filters to a parent's children.
//   4. listTickets({ parentId: null }) returns only top-level tickets.
//
// Deterministic: SQLite in a per-test temp workspace, no network, no daemon.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-parent-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-parent-${++seq}`,
    title: "parent test",
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

describe("db parentId", () => {
  it("round-trips parentId and reads null when absent", () => {
    db.saveTicket(makeTicket({ id: "T-epic" }));
    db.saveTicket(makeTicket({ id: "T-child", parentId: "T-epic" }));

    expect(db.getTicket("T-epic")!.parentId).toBeNull();
    expect(db.getTicket("T-child")!.parentId).toBe("T-epic");
  });

  it("filters children by parentId", () => {
    db.saveTicket(makeTicket({ id: "P1" }));
    db.saveTicket(makeTicket({ id: "P1-a", parentId: "P1" }));
    db.saveTicket(makeTicket({ id: "P1-b", parentId: "P1" }));
    db.saveTicket(makeTicket({ id: "P2" }));
    db.saveTicket(makeTicket({ id: "P2-a", parentId: "P2" }));

    const kids = db.listTickets({ parentId: "P1" }).map((t: any) => t.id).sort();
    expect(kids).toEqual(["P1-a", "P1-b"]);
  });

  it("filters top-level tickets with parentId: null", () => {
    // Fresh markers so the assertion isn't polluted by earlier rows.
    db.saveTicket(makeTicket({ id: "TOP-1" }));
    db.saveTicket(makeTicket({ id: "TOP-2" }));
    db.saveTicket(makeTicket({ id: "SUB-1", parentId: "TOP-1" }));

    const topIds = db.listTickets({ parentId: null }).map((t: any) => t.id);
    expect(topIds).toContain("TOP-1");
    expect(topIds).toContain("TOP-2");
    expect(topIds).not.toContain("SUB-1");
  });
});
