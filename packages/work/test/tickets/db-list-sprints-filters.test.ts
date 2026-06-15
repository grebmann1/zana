// Focused test for the _listSprints filter branches in db.ts.
//
// db.test.ts covers the `status` filter and db-list-ordering.test.ts uses the
// `teamId` filter only as an ordering-isolation scope. The `daemonId` filter
// branch (db.ts lines 206-209) and the *exclusion* semantics of `teamId`
// (rows that don't match must be omitted) are otherwise unexercised. This file
// pins both so a future refactor cannot silently drop a WHERE clause.
//
// Real SQLite, temp workspace (same bootstrap as db.test.ts). Each test file
// runs in its own vitest fork, so the module-level `_db` singleton is fresh.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as db from "@zana-ai/work/src/tickets/db.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-db-sprint-filter-"));
  fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
  workspaceContext.init(tmpRoot);
  try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function makeSprint(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `S-${Date.now()}-${++seq}`,
    name: "Sprint",
    status: "planning",
    ticketIds: [] as string[],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("db — listSprints daemonId filter", () => {
  it("returns only sprints owned by the requested daemon, excluding others", () => {
    const daemon = `daemon-${++seq}`;
    const mine = makeSprint({ daemonId: daemon });
    const other = makeSprint({ daemonId: `other-${++seq}` });
    const noDaemon = makeSprint({ daemonId: null });
    db.saveSprint(mine);
    db.saveSprint(other);
    db.saveSprint(noDaemon);

    const ids = db.listSprints({ daemonId: daemon }).map((s: any) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(noDaemon.id);
  });
});

describe("db — listSprints teamId filter exclusion", () => {
  it("omits sprints belonging to a different team", () => {
    const team = `team-${++seq}`;
    const mine = makeSprint({ teamId: team });
    const other = makeSprint({ teamId: `other-team-${++seq}` });
    db.saveSprint(mine);
    db.saveSprint(other);

    const ids = db.listSprints({ teamId: team }).map((s: any) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });
});
