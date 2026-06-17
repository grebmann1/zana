// Pins the FIRST clause of the checkpointPath() id guard in
// packages/work/src/runs/checkpoint/store.ts:
//
//   if (typeof id !== "string" || id.length === 0) throw "...non-empty string"
//
// The existing store.test.ts covers the SECOND clause (empty string `""`,
// whose `typeof` is still "string") and the separate path-traversal guard,
// but never a NON-string id. A regression that relaxed the guard to a bare
// `!id` check would wrongly accept a numeric id like `123` (truthy, non-string)
// and let path.join coerce it — so this locks the type half of the contract.
//
// Pure boundary validation: each call throws before any fs access, so no real
// I/O, clock, or network is involved (a tmp workspace is still set up for the
// dist-resolved getDir() path, matching the sibling CRUD suite).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

describe("checkpoint store: non-string id guard", () => {
  let tmpRoot: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-idtype-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Distinct from load("") — these are non-strings, so the `typeof !== "string"`
  // half of the guard fires, not the `.length === 0` half.
  for (const [label, badId] of [
    ["a number", 123],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array", []],
  ] as Array<[string, unknown]>) {
    it(`load() throws for a non-string id (${label})`, () => {
      expect(() => store.load(badId)).toThrow("non-empty string");
    });
  }

  it("remove() rejects a non-string id with the same guard (no fs touch)", () => {
    expect(() => store.remove(123)).toThrow("non-empty string");
  });

  it("update() rejects a non-string id before any read-modify-write", () => {
    expect(() => store.update(456, { status: "done" })).toThrow("non-empty string");
  });

  it("save() rejects a truthy non-string id rather than coercing it", () => {
    // id is truthy so it is NOT auto-replaced by randomUUID(); checkpointPath
    // then rejects it on the type clause.
    expect(() => store.save({ id: 789, status: "running" })).toThrow("non-empty string");
  });
});
