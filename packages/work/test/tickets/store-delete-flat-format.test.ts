// Tests for deleteTicket()'s legacy flat-file deletion branch in
// packages/work/src/tickets/store.ts (lines 206-214).
//
// store.test.ts covers deleteTicket on a *directory*-format ticket (the path
// produced by saveTicket) and the ghost-id → false path, but never the legacy
// flat-file branch: a ticket persisted as a bare <id>.json with no <id>/
// directory. deleteTicket tries the directory form first, finds none, and must
// fall through to `fs.unlinkSync(<id>.json)`, return true, and regenerate the
// index so the stale id leaves listings. A regression that dropped the flat
// fallback would silently fail to delete legacy records (returning false and
// leaving the file on disk). This pins that branch.
//
// Deterministic: temp workspace per test, no clock/network/global state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/tickets/store.ts";

function getTicketsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
}

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "T-x",
    title: "Test ticket",
    status: "backlog",
    priority: "medium",
    labels: [] as string[],
    comments: [],
    audit: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seedFlatTicket(id: string, overrides: Record<string, unknown> = {}): string {
  const ticketsDir = getTicketsDir();
  fs.mkdirSync(ticketsDir, { recursive: true });
  const flatPath = path.join(ticketsDir, `${id}.json`);
  fs.writeFileSync(
    flatPath,
    JSON.stringify(makeTicket({ id, ...overrides }), null, 2),
    "utf8"
  );
  return flatPath;
}

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-ticket-del-flat-${Date.now()}-${process.pid}`
  );
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe("deleteTicket — legacy flat-file branch", () => {
  it("deletes a flat <id>.json (no directory form), returns true, and removes the file", () => {
    const flatPath = seedFlatTicket("T-flat-del", { title: "Legacy" });
    expect(fs.existsSync(flatPath)).toBe(true);
    // No directory form exists — only the flat file.
    expect(fs.existsSync(path.join(getTicketsDir(), "T-flat-del"))).toBe(false);

    expect(store.deleteTicket("T-flat-del")).toBe(true);

    // The flat file is gone and the ticket no longer resolves.
    expect(fs.existsSync(flatPath)).toBe(false);
    expect(store.getTicket("T-flat-del")).toBeNull();
  });

  it("drops the deleted flat ticket from listTickets (index regenerated)", () => {
    seedFlatTicket("T-flat-list", { title: "Legacy in list" });
    // Sanity: it is listable before deletion (listTickets reads flat files too).
    expect(store.listTickets().map((t: any) => t.id)).toContain("T-flat-list");

    store.deleteTicket("T-flat-list");

    expect(store.listTickets().map((t: any) => t.id)).not.toContain("T-flat-list");
  });
});
