// Tests the defensive `if (!d) continue;` branch of listDeliberations().
//
// listDeliberations() reads every checkpoint of kind "deliberation" and pulls
// the `deliberation` field off each record. A checkpoint of that kind written
// WITHOUT a `deliberation` field (e.g. a malformed/legacy record, or a future
// schema variant) must be silently skipped — not surfaced as an `undefined`
// entry and not crash the listing. The existing run-list-expired.test.ts only
// exercises well-formed records, so this branch is otherwise uncovered.

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

describe("listDeliberations — malformed records without a deliberation field", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-delib-malformed-"));
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

  it("skips a deliberation-kind checkpoint missing the deliberation field while returning valid ones", () => {
    // One well-formed deliberation record.
    const valid = run.propose({
      question: "Should we ship?",
      voters: [{ profileId: "architect" }],
      promptSnapshot: "prompt body",
    });

    // A checkpoint of the SAME kind but with NO `deliberation` field — the
    // malformed/legacy record the defensive branch is meant to drop.
    checkpointStore.save({
      id: "malformed-no-deliberation",
      kind: CHECKPOINT_KIND,
      // deliberation field intentionally omitted
    });

    const listed = run.listDeliberations();

    // The malformed record must not appear, and no undefined entries leak in.
    expect(listed.every((d) => d != null)).toBe(true);
    expect(listed.find((d) => d.id === "malformed-no-deliberation")).toBeUndefined();

    // The valid deliberation is still returned untouched.
    const found = listed.find((d) => d.id === valid.id);
    expect(found).toBeDefined();
    expect(found!.state).toBe("PROPOSED");
  });
});
