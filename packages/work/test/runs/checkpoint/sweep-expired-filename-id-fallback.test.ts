// Pins the filename-derived id fallback in sweepExpired() in
// packages/work/src/runs/checkpoint/store.ts:
//
//   let id = file.replace(/\.json$/, "");
//   ...
//   id = data.id || id;        // <-- fallback when the record has no `id`
//
// Every existing sweepExpired test (checkpoint-ttl.test.ts) plants records via
// store.save(), which always stamps an `id` — so the `data.id ||` short-circuit
// is always taken and the filename-derived fallback never runs. A checkpoint
// file can legitimately lack an `id` (hand-written fixtures, a truncated/partial
// record, or a legacy format), and sweepExpired must still report WHICH file it
// removed for observability. A regression that pushed `data.id` verbatim (or
// `undefined`) into the `removed` array would slip past every current test but
// is caught here.
//
// Deterministic: `now` is passed explicitly to sweepExpired() so no real wall
// clock is involved, and all fs I/O lives in a tmp dir torn down in afterEach.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";

describe("checkpoint store: sweepExpired filename-id fallback for record without `id`", () => {
  // Fixed reference instant — sweepExpired() takes `now` as an argument, so the
  // test never depends on the real clock.
  const NOW = 1_700_000_000_000;
  let tmpRoot: string;
  let ckptDir: string;
  let store: any;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-ckpt-noid-sweep-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    store = await import("@zana-ai/work/src/runs/checkpoint/store.ts");
    store.init(tmpRoot); // creates + resets the checkpoints dir
    ckptDir = join(tmpRoot, "checkpoints");
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("reports the filename base (not undefined) when an expired record has no `id`", () => {
    // Hand-write an expired checkpoint that omits the `id` field entirely.
    writeFileSync(
      join(ckptDir, "orphan-noid.json"),
      JSON.stringify({ expiresAt: NOW - 1000, status: "running" }),
    );

    const result = store.sweepExpired(NOW);

    // The swept id falls back to the filename base — never undefined/null.
    expect(result.removed).toContain("orphan-noid");
    expect(result.removed).not.toContain(undefined);
    // ...and the file is actually gone.
    expect(existsSync(join(ckptDir, "orphan-noid.json"))).toBe(false);
  });

  it("leaves a not-yet-expired record without an `id` untouched", () => {
    writeFileSync(
      join(ckptDir, "fresh-noid.json"),
      JSON.stringify({ expiresAt: NOW + 10_000 }),
    );

    const result = store.sweepExpired(NOW);

    expect(result.removed).not.toContain("fresh-noid");
    expect(existsSync(join(ckptDir, "fresh-noid.json"))).toBe(true);
  });
});
