// Tests for packages/work/src/tickets/store.ts
//
// Covers the happy path, filter paths, edge cases, and old/new format
// compatibility.  A temp directory is used for every test; the workspace
// context is reinitialised so all reads/writes stay inside the temp tree.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/tickets/store.ts";

// Resolve the tickets dir via the same code-path the store uses
// (require("@zana-ai/core").project.workspaceContext after init).
function getTicketsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
}

// ── helpers ────────────────────────────────────────────────────────────────

function makeTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `T-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ── setup / teardown ────────────────────────────────────────────────────────

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-ticket-store-${Date.now()}-${process.pid}`
  );
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  // Init both the source-module singleton and the dist-module singleton so
  // that the store (which calls require("@zana-ai/core")) sees the temp dir.
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

// ── saveTicket / getTicket round-trip ───────────────────────────────────────

describe("saveTicket / getTicket", () => {
  it("persists a ticket and retrieves it by id", () => {
    const t = makeTicket({ id: "T-round-trip", title: "Round-trip test" });
    store.saveTicket(t);
    const fetched = store.getTicket("T-round-trip");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("T-round-trip");
    expect(fetched!.title).toBe("Round-trip test");
  });

  it("saves in directory format (ticket.json inside subdir)", () => {
    const t = makeTicket({ id: "T-dir-fmt" });
    store.saveTicket(t);
    const ticketsDir = getTicketsDir();
    const dirPath = path.join(ticketsDir, "T-dir-fmt", "ticket.json");
    expect(fs.existsSync(dirPath)).toBe(true);
  });

  it("overwrites an existing ticket on re-save", () => {
    const t = makeTicket({ id: "T-overwrite", title: "Original" });
    store.saveTicket(t);
    store.saveTicket({ ...t, title: "Updated", status: "in-progress" });
    const fetched = store.getTicket("T-overwrite");
    expect(fetched!.title).toBe("Updated");
    expect(fetched!.status).toBe("in-progress");
  });

  it("getTicket returns null for an unknown id", () => {
    expect(store.getTicket("no-such-ticket")).toBeNull();
  });
});

// ── old flat-file format (legacy read) ─────────────────────────────────────

describe("getTicket — legacy flat-file format fallback", () => {
  it("reads a ticket stored as a flat <id>.json file", () => {
    const ticketsDir = getTicketsDir();
    fs.mkdirSync(ticketsDir, { recursive: true });
    const t = makeTicket({ id: "T-flat" });
    fs.writeFileSync(
      path.join(ticketsDir, "T-flat.json"),
      JSON.stringify(t, null, 2),
      "utf8"
    );
    const fetched = store.getTicket("T-flat");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("T-flat");
  });
});

// ── listTickets ────────────────────────────────────────────────────────────

describe("listTickets", () => {
  it("returns all tickets when no filter is given", () => {
    store.saveTicket(makeTicket({ id: "T-ls-1" }));
    store.saveTicket(makeTicket({ id: "T-ls-2" }));
    const ids = store.listTickets().map((t) => t.id);
    expect(ids).toContain("T-ls-1");
    expect(ids).toContain("T-ls-2");
  });

  it("returns [] when the store is empty", () => {
    expect(store.listTickets()).toEqual([]);
  });

  it("filters by status", () => {
    store.saveTicket(makeTicket({ id: "T-s-backlog", status: "backlog" }));
    store.saveTicket(makeTicket({ id: "T-s-done", status: "done" }));
    const results = store.listTickets({ status: "backlog" });
    expect(results.every((t) => t.status === "backlog")).toBe(true);
    expect(results.map((t) => t.id)).toContain("T-s-backlog");
    expect(results.map((t) => t.id)).not.toContain("T-s-done");
  });

  it("filters by label", () => {
    store.saveTicket(makeTicket({ id: "T-lbl-a", labels: ["bug", "urgent"] }));
    store.saveTicket(makeTicket({ id: "T-lbl-b", labels: ["feature"] }));
    const bugs = store.listTickets({ label: "bug" });
    expect(bugs.map((t) => t.id)).toContain("T-lbl-a");
    expect(bugs.map((t) => t.id)).not.toContain("T-lbl-b");
  });

  it("filters by priority", () => {
    store.saveTicket(makeTicket({ id: "T-hi", priority: "high" }));
    store.saveTicket(makeTicket({ id: "T-lo", priority: "low" }));
    const high = store.listTickets({ priority: "high" });
    expect(high.map((t) => t.id)).toContain("T-hi");
    expect(high.map((t) => t.id)).not.toContain("T-lo");
  });

  it("returns tickets sorted newest-first (by updatedAt)", () => {
    const older = makeTicket({ id: "T-older", updatedAt: "2024-01-01T00:00:00.000Z" });
    const newer = makeTicket({ id: "T-newer", updatedAt: "2025-01-01T00:00:00.000Z" });
    store.saveTicket(older);
    store.saveTicket(newer);
    const ids = store.listTickets().map((t) => t.id);
    expect(ids.indexOf("T-newer")).toBeLessThan(ids.indexOf("T-older"));
  });

  it("silently skips malformed JSON files in the tickets dir", () => {
    store.saveTicket(makeTicket({ id: "T-good" }));
    // saveTicket already created the dir; use the store's own path resolution.
    const ticketsDir = getTicketsDir();
    fs.mkdirSync(ticketsDir, { recursive: true });
    fs.writeFileSync(path.join(ticketsDir, "corrupt.json"), "{ bad json {{", "utf8");
    const ids = store.listTickets().map((t) => t.id);
    expect(ids).toContain("T-good");
    expect(ids).not.toContain("corrupt");
  });
});

// ── deleteTicket ────────────────────────────────────────────────────────────

describe("deleteTicket", () => {
  it("removes a ticket and returns true", () => {
    store.saveTicket(makeTicket({ id: "T-del-1" }));
    expect(store.deleteTicket("T-del-1")).toBe(true);
    expect(store.getTicket("T-del-1")).toBeNull();
  });

  it("returns false for a non-existent id", () => {
    expect(store.deleteTicket("T-ghost")).toBe(false);
  });

  it("deleted ticket no longer appears in listTickets", () => {
    store.saveTicket(makeTicket({ id: "T-del-2" }));
    store.deleteTicket("T-del-2");
    expect(store.listTickets().map((t) => t.id)).not.toContain("T-del-2");
  });
});
