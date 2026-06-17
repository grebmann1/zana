// Tests for saveTicket()'s legacy flat-file → directory migration in
// packages/work/src/tickets/store.ts.
//
// store.test.ts covers reading a legacy flat <id>.json (getTicket fallback) and
// saving in directory format, but never the *migration* edge: a ticket that
// already exists on disk as a flat <id>.json, then gets saved. saveTicket must
// (1) write the new directory form (<id>/ticket.json) AND (2) unlink the stale
// flat file, so a single getTicket no longer has two competing on-disk copies.
// A regression that dropped the `fs.unlinkSync(flatPath)` cleanup would leave a
// stale duplicate that the directory-first read masks — silently undetected.
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

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-ticket-flat-mig-${Date.now()}-${process.pid}`
  );
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe("saveTicket — legacy flat-file migration", () => {
  it("migrates a flat <id>.json to directory format and removes the stale flat file", () => {
    const ticketsDir = getTicketsDir();
    fs.mkdirSync(ticketsDir, { recursive: true });

    // Seed a legacy flat-file ticket on disk.
    const flatPath = path.join(ticketsDir, "T-mig.json");
    fs.writeFileSync(
      flatPath,
      JSON.stringify(makeTicket({ id: "T-mig", title: "Legacy" }), null, 2),
      "utf8"
    );
    expect(fs.existsSync(flatPath)).toBe(true);

    // Re-save the same id — should migrate to directory form.
    store.saveTicket(makeTicket({ id: "T-mig", title: "Migrated", status: "in-progress" }));

    // Directory form now exists with the updated payload...
    const dirTicketPath = path.join(ticketsDir, "T-mig", "ticket.json");
    expect(fs.existsSync(dirTicketPath)).toBe(true);

    // ...and the stale flat file is gone (no competing duplicate copy).
    expect(fs.existsSync(flatPath)).toBe(false);

    // A single read returns exactly the migrated ticket.
    const fetched = store.getTicket("T-mig");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Migrated");
    expect(fetched!.status).toBe("in-progress");
  });

  it("saves cleanly when no legacy flat file exists (unlink miss is swallowed)", () => {
    const t = makeTicket({ id: "T-nolegacy", title: "Fresh" });
    expect(() => store.saveTicket(t)).not.toThrow();

    const ticketsDir = getTicketsDir();
    expect(fs.existsSync(path.join(ticketsDir, "T-nolegacy", "ticket.json"))).toBe(true);
    expect(fs.existsSync(path.join(ticketsDir, "T-nolegacy.json"))).toBe(false);
    expect(store.getTicket("T-nolegacy")!.title).toBe("Fresh");
  });
});
