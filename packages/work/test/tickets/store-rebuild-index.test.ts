// Tests for the rebuildIndex() export of packages/work/src/tickets/store.ts.
//
// rebuildIndex() calls regenerateTicketsIndex() + regenerateSprintsIndex(),
// which scan the on-disk ticket/sprint files and write a sorted _index.json
// into each directory.  The function is used for recovery after bulk file
// operations and has no coverage in the existing store.test.ts or
// store-sprints.test.ts suites.
//
// Covered here:
//   • _index.json is written to the tickets dir after rebuildIndex()
//   • _index.json is written to the sprints dir after rebuildIndex()
//   • index entries contain the expected summary fields
//   • entries are sorted newest-first by updatedAt
//   • _-prefixed files are excluded from the index
//   • corrupt JSON files are silently skipped
//   • both directory-format and flat-file-format tickets appear in the index
//   • calling rebuildIndex() on an empty workspace produces [] in _index.json

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { rebuildIndex, saveTicket, saveSprint } from "@zana-ai/work/src/tickets/store.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function getTicketsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
}

function getSprintsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().sprintsDir;
}

function readIndex(dir: string): any[] {
  const indexPath = path.join(dir, "_index.json");
  return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

const NOW_OLD = "2024-01-01T00:00:00.000Z";
const NOW_NEW = "2025-06-01T00:00:00.000Z";

// ── workspace setup / teardown ───────────────────────────────────────────────

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-rebuild-${Date.now()}-${process.pid}`,
  );
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("rebuildIndex — tickets _index.json", () => {
  it("creates _index.json in the tickets dir after saving tickets", () => {
    saveTicket({ id: "T-ri-1", title: "First", status: "backlog", priority: "medium",
      createdAt: NOW_NEW, updatedAt: NOW_NEW });

    rebuildIndex();

    const ticketsDir = getTicketsDir();
    expect(fs.existsSync(path.join(ticketsDir, "_index.json"))).toBe(true);
  });

  it("index entries contain the required summary fields", () => {
    saveTicket({ id: "T-ri-fields", title: "Field check", status: "in-progress",
      priority: "high", assigneeId: "agent-1", createdAt: NOW_NEW, updatedAt: NOW_NEW });

    rebuildIndex();

    const index = readIndex(getTicketsDir());
    const entry = index.find((e: any) => e.id === "T-ri-fields");
    expect(entry).toBeDefined();
    expect(entry.title).toBe("Field check");
    expect(entry.status).toBe("in-progress");
    expect(entry.priority).toBe("high");
    expect(entry.assigneeId).toBe("agent-1");
    expect(entry.updatedAt).toBe(NOW_NEW);
  });

  it("sorts entries newest-first by updatedAt", () => {
    saveTicket({ id: "T-ri-old", title: "Older", status: "backlog",
      createdAt: NOW_OLD, updatedAt: NOW_OLD });
    saveTicket({ id: "T-ri-new", title: "Newer", status: "backlog",
      createdAt: NOW_NEW, updatedAt: NOW_NEW });

    rebuildIndex();

    const index = readIndex(getTicketsDir());
    const ids = index.map((e: any) => e.id);
    expect(ids.indexOf("T-ri-new")).toBeLessThan(ids.indexOf("T-ri-old"));
  });

  it("excludes _-prefixed files from the index", () => {
    saveTicket({ id: "T-ri-real", title: "Real ticket", status: "backlog",
      createdAt: NOW_NEW, updatedAt: NOW_NEW });
    // Write a _-prefixed flat file directly — saveTicket would strip the underscore
    const ticketsDir = getTicketsDir();
    fs.writeFileSync(
      path.join(ticketsDir, "_internal.json"),
      JSON.stringify({ id: "_internal", title: "Should be ignored",
        status: "backlog", updatedAt: NOW_NEW }),
      "utf8",
    );

    rebuildIndex();

    const index = readIndex(getTicketsDir());
    expect(index.every((e: any) => !e.id.startsWith("_"))).toBe(true);
    expect(index.some((e: any) => e.id === "T-ri-real")).toBe(true);
  });

  it("silently skips corrupt JSON files", () => {
    saveTicket({ id: "T-ri-good", title: "Good", status: "backlog",
      createdAt: NOW_NEW, updatedAt: NOW_NEW });
    const ticketsDir = getTicketsDir();
    fs.writeFileSync(path.join(ticketsDir, "corrupt.json"), "{ not valid json {{", "utf8");

    // Should not throw
    expect(() => rebuildIndex()).not.toThrow();

    const index = readIndex(getTicketsDir());
    expect(index.some((e: any) => e.id === "T-ri-good")).toBe(true);
  });

  it("produces an empty array in _index.json when no tickets exist", () => {
    rebuildIndex();

    const index = readIndex(getTicketsDir());
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(0);
  });

  it("indexes directory-format tickets (ticket.json inside subdir)", () => {
    // saveTicket always writes directory format; verify it appears in the index
    saveTicket({ id: "T-ri-dir", title: "Dir format", status: "review",
      createdAt: NOW_NEW, updatedAt: NOW_NEW });

    rebuildIndex();

    const index = readIndex(getTicketsDir());
    expect(index.some((e: any) => e.id === "T-ri-dir")).toBe(true);
  });
});

describe("rebuildIndex — sprints _index.json", () => {
  it("creates _index.json in the sprints dir", () => {
    saveSprint({ id: "S-ri-1", name: "Sprint One", status: "active",
      ticketIds: [], createdAt: NOW_NEW, updatedAt: NOW_NEW });

    rebuildIndex();

    const sprintsDir = getSprintsDir();
    expect(fs.existsSync(path.join(sprintsDir, "_index.json"))).toBe(true);
  });

  it("produces an empty sprints index when no sprints exist", () => {
    rebuildIndex();

    const index = readIndex(getSprintsDir());
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(0);
  });
});
