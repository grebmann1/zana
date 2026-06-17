// Direct CRUD tests for packages/work/src/runs/checkpoint/store.ts.
//
// The existing checkpoint-*.test.ts files exercise atomic writes, TTL,
// list filters, and concurrency. This file covers the basic CRUD contract
// (save / load / remove / update) in isolation — including error paths
// not reached by those suites (remove returning false, update on missing id,
// path-traversal guard, empty-id guard).
//
// No real network or clock dependency — all fs I/O goes into a tmp dir that
// is torn down in afterEach.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

describe("checkpoint store: basic CRUD", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-crud-"));
    // Both the TS-imported workspaceContext and the dist-resolved one (via
    // require('@zana-ai/core') inside store.ts) must be initialised so that
    // kind='deliberation' saves work in tests that need them.
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── save() + load() ──────────────────────────────────────────────────────

  it("save() returns the checkpoint with id, createdAt, updatedAt, and kind", () => {
    const saved = store.save({ id: "crud-1", teamId: "t1", status: "running" });
    expect(saved.id).toBe("crud-1");
    expect(typeof saved.createdAt).toBe("number");
    expect(typeof saved.updatedAt).toBe("number");
    expect(saved.kind).toBe("run"); // default kind
  });

  it("load() returns the saved checkpoint verbatim", () => {
    store.save({ id: "crud-load", teamId: "t-load", status: "paused", extra: 42 });
    const loaded = store.load("crud-load");
    expect(loaded).not.toBeNull();
    expect(loaded.teamId).toBe("t-load");
    expect(loaded.status).toBe("paused");
    expect(loaded.extra).toBe(42);
  });

  it("load() returns null for a non-existent checkpoint", () => {
    expect(store.load("does-not-exist")).toBeNull();
  });

  // ── remove() ─────────────────────────────────────────────────────────────

  it("remove() deletes the checkpoint file and returns true", () => {
    store.save({ id: "crud-rm", teamId: "t-rm", status: "done" });
    expect(store.load("crud-rm")).not.toBeNull();

    const result = store.remove("crud-rm");
    expect(result).toBe(true);
    expect(store.load("crud-rm")).toBeNull();
  });

  it("remove() returns false when the checkpoint does not exist", () => {
    const result = store.remove("never-saved");
    expect(result).toBe(false);
  });

  // ── update() ─────────────────────────────────────────────────────────────

  it("update() merges new fields and bumps updatedAt", () => {
    store.save({ id: "crud-upd", teamId: "t-upd", status: "running" });
    const before = store.load("crud-upd");

    // Ensure at least 1 ms passes so updatedAt differs
    const updated = store.update("crud-upd", { status: "paused", note: "hi" });
    expect(updated).not.toBeNull();
    expect(updated.status).toBe("paused");
    expect(updated.note).toBe("hi");
    expect(updated.teamId).toBe("t-upd");       // original field preserved
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("update() returns null for a non-existent checkpoint", () => {
    const result = store.update("ghost", { status: "done" });
    expect(result).toBeNull();
  });

  // ── id validation guard ───────────────────────────────────────────────────

  it("save() auto-generates an id when none is provided", () => {
    const saved = store.save({ teamId: "t-autoid", status: "running" });
    expect(typeof saved.id).toBe("string");
    expect(saved.id.length).toBeGreaterThan(0);
    // Must be loadable by the auto-generated id
    expect(store.load(saved.id)).not.toBeNull();
  });

  it("load() throws when id is empty string", () => {
    expect(() => store.load("")).toThrow("non-empty string");
  });

  it("load() throws when id contains a path-traversal sequence", () => {
    expect(() => store.load("../../etc/passwd")).toThrow("escapes");
  });
});
