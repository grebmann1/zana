// Additional getTicket() edge coverage for packages/work/src/tickets/store.ts.
//
// store.test.ts already pins the happy path, the flat-file fallback, and
// "unknown id → null". It does NOT pin two real getTicket branches:
//
//   1. A directory-format ticket whose ticket.json is corrupt JSON must
//      resolve to null (src/tickets/store.ts line ~170: the try/catch around
//      JSON.parse of the directory ticket.json). store.test.ts only exercises
//      the corrupt-file case through listTickets (silent-skip), never through
//      getTicket — a different code path with its own catch.
//
//   2. When BOTH a directory-format ticket (<id>/ticket.json) and a legacy
//      flat file (<id>.json) exist for the same id, getTicket must prefer the
//      directory format (it is checked first, lines ~169 before ~174). This
//      precedence is the contract that makes the save-time flat→dir migration
//      safe, and nothing currently pins it.
//
// A temp workspace is used per test; no real network, no real clock-sensitive
// behavior, deterministic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/tickets/store.ts";

function getTicketsDir(): string {
  return (core as any).project.workspaceContext.getProjectPaths().ticketsDir;
}

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

let TEST_WORKSPACE: string;

beforeEach(() => {
  TEST_WORKSPACE = path.join(
    os.tmpdir(),
    `zana-test-store-getticket-edges-${Date.now()}-${process.pid}`
  );
  fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
  workspaceContext.init(TEST_WORKSPACE);
  try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
});

afterEach(() => {
  try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe("getTicket — corrupt directory-format ticket.json", () => {
  it("returns null when <id>/ticket.json contains invalid JSON", () => {
    const ticketsDir = getTicketsDir();
    const dir = path.join(ticketsDir, "T-corrupt-dir");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ticket.json"), "{ not: valid json {{", "utf8");

    // The directory exists and ticket.json exists, so getTicket takes the
    // directory branch — the JSON.parse must fail into the catch and yield null
    // rather than throwing.
    expect(() => store.getTicket("T-corrupt-dir")).not.toThrow();
    expect(store.getTicket("T-corrupt-dir")).toBeNull();
  });
});

describe("getTicket — directory format takes precedence over legacy flat file", () => {
  it("returns the directory-format ticket when both <id>/ticket.json and <id>.json exist", () => {
    const ticketsDir = getTicketsDir();
    fs.mkdirSync(ticketsDir, { recursive: true });

    // Legacy flat file with a stale title.
    const flat = makeTicket({ id: "T-dup", title: "FLAT (stale)" });
    fs.writeFileSync(
      path.join(ticketsDir, "T-dup.json"),
      JSON.stringify(flat, null, 2),
      "utf8"
    );

    // Directory-format file with the authoritative title.
    const dir = path.join(ticketsDir, "T-dup");
    fs.mkdirSync(dir, { recursive: true });
    const nested = makeTicket({ id: "T-dup", title: "DIR (authoritative)" });
    fs.writeFileSync(path.join(dir, "ticket.json"), JSON.stringify(nested, null, 2), "utf8");

    const fetched = store.getTicket("T-dup");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("DIR (authoritative)");
  });
});
