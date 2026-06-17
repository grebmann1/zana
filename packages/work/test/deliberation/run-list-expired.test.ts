// Tests the `includeExpired` path of listDeliberations().
//
// listDeliberations() delegates to checkpointStore.list({ includeExpired }).
// The default call (no filter / includeExpired omitted) excludes checkpoints
// whose `expiresAt` lies in the past. With { includeExpired: true } they are
// returned. This file exercises that branch specifically — the existing
// listDeliberations({state}) test in run.test.ts only covers the state-filter
// path using non-expired records.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as runtimeConfig from "@zana-ai/work/src/deliberation/runtime-config.ts";

const CHECKPOINT_KIND = "deliberation";

describe("listDeliberations — includeExpired option", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-delib-expired-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
    runtimeConfig.resetRuntimeConfig();
  });

  afterEach(() => {
    runtimeConfig.resetRuntimeConfig();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("omits expired deliberations by default (includeExpired not set)", () => {
    // Propose a deliberation so we have a valid record in the checkpoint store.
    const d = run.propose({
      question: "Should we adopt the new API?",
      voters: [{ profileId: "architect" }],
      promptSnapshot: "prompt body",
    });

    // Overwrite the checkpoint with an expiresAt in the past so it is expired.
    checkpointStore.save({
      id: d.id,
      kind: CHECKPOINT_KIND,
      deliberation: d,
      expiresAt: Date.now() - 1000, // 1 second in the past
    });

    // Default call must exclude the expired deliberation.
    const visible = run.listDeliberations();
    expect(visible.find((x) => x.id === d.id)).toBeUndefined();
  });

  it("returns expired deliberations when includeExpired is true", () => {
    const d = run.propose({
      question: "Should we adopt the new API?",
      voters: [{ profileId: "architect" }],
      promptSnapshot: "prompt body",
    });

    // Expire the record.
    checkpointStore.save({
      id: d.id,
      kind: CHECKPOINT_KIND,
      deliberation: d,
      expiresAt: Date.now() - 1000,
    });

    // With includeExpired: true the record must be returned.
    const withExpired = run.listDeliberations({ includeExpired: true });
    const found = withExpired.find((x) => x.id === d.id);
    expect(found).toBeDefined();
    expect(found!.state).toBe("PROPOSED");
  });

  it("state filter still applies when includeExpired is true", () => {
    // Propose two deliberations; expire both; transition one to REVIEWING.
    const a = run.propose({
      question: "Question A",
      voters: [{ profileId: "architect" }],
      promptSnapshot: "p",
    });
    const b = run.propose({
      question: "Question B",
      voters: [{ profileId: "architect" }],
      promptSnapshot: "p",
    });

    run.transition(b.id, "REVIEWING");

    const pastExpiry = Date.now() - 1000;
    // Reload deliberations so we have the current state for each.
    const aLoaded = run.loadDeliberation(a.id)!;
    const bLoaded = run.loadDeliberation(b.id)!;

    checkpointStore.save({ id: a.id, kind: CHECKPOINT_KIND, deliberation: aLoaded, expiresAt: pastExpiry });
    checkpointStore.save({ id: b.id, kind: CHECKPOINT_KIND, deliberation: bLoaded, expiresAt: pastExpiry });

    // Both expired — default list returns nothing.
    expect(run.listDeliberations()).toHaveLength(0);

    // includeExpired:true + state filter returns only the matching one.
    const proposed = run.listDeliberations({ state: "PROPOSED", includeExpired: true });
    expect(proposed).toHaveLength(1);
    expect(proposed[0].id).toBe(a.id);

    const reviewing = run.listDeliberations({ state: "REVIEWING", includeExpired: true });
    expect(reviewing).toHaveLength(1);
    expect(reviewing[0].id).toBe(b.id);
  });

  it("non-expired deliberations are always included regardless of the flag", () => {
    const live = run.propose({
      question: "Live deliberation",
      voters: [{ profileId: "researcher" }],
      promptSnapshot: "p",
    });
    // Do NOT expire it — expiresAt is far in the future (7 days from propose()).

    const withoutFlag = run.listDeliberations();
    expect(withoutFlag.find((x) => x.id === live.id)).toBeDefined();

    const withFlag = run.listDeliberations({ includeExpired: true });
    expect(withFlag.find((x) => x.id === live.id)).toBeDefined();
  });
});
