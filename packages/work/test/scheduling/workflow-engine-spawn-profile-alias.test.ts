// Pins the `step.profile` alias branch in executeStep's "spawn" case
// (workflow-engine.ts line 155):
//
//   const profileId = step.profile || step.profileId;
//
// Every existing spawn-step test (workflow-engine-spawn-step.test.ts,
// workflow-engine-failed-run.test.ts) supplies the canonical `profileId` key,
// so the left-hand `step.profile` alias has never been exercised. A regression
// that dropped the alias (e.g. `const profileId = step.profileId;`) would slip
// through the whole suite unnoticed. This test forces resolution through
// `step.profile` and asserts the id flows into the downstream profile lookup.
//
// Deterministic: the real profileStore.getProfile() returns null for a
// synthetic id (no agent is ever spawned), real FS under a tmp workspace,
// no network, no real Claude.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import { executeWorkflow } from "@zana-ai/work/src/scheduling/workflow-engine.ts";

const TEST_WS = path.join(
  os.tmpdir(),
  `zana-test-wfe-profile-alias-${Date.now()}-${process.pid}`,
);

const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}
function initWorkspace(root: string) {
  for (const wc of [workspaceContext as any, wcDist]) {
    try { wc.init(root); } catch {}
  }
}

describe("executeWorkflow — spawn step: `profile` alias resolves the profile id", () => {
  beforeEach(() => {
    resetWorkspace();
    fs.mkdirSync(path.join(TEST_WS, ".zana"), { recursive: true });
    initWorkspace(TEST_WS);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WS, { recursive: true, force: true }); } catch {}
    resetWorkspace();
  });

  it("uses step.profile (not just step.profileId) for the profile lookup", async () => {
    // Only the `profile` alias is supplied — no `profileId`. The id must still
    // reach getProfile(), surfacing in the not-found error message verbatim.
    const run = await executeWorkflow({
      id: "spawn-profile-alias",
      name: "Spawn Profile Alias",
      steps: [{ action: "spawn", profile: "alias-only-profile-zana-test" }],
    });

    expect(run.steps[0].result).toMatchObject({
      error: expect.stringContaining("profile not found"),
    });
    expect(run.steps[0].result.error).toContain("alias-only-profile-zana-test");
  });

  it("prefers step.profile over step.profileId when both are present", async () => {
    // `profile` is the left operand of the `||`, so it wins over `profileId`.
    const run = await executeWorkflow({
      id: "spawn-profile-precedence",
      name: "Spawn Profile Precedence",
      steps: [
        {
          action: "spawn",
          profile: "winning-profile-zana-test",
          profileId: "losing-profile-zana-test",
        },
      ],
    });

    const err = run.steps[0].result.error as string;
    expect(err).toContain("winning-profile-zana-test");
    expect(err).not.toContain("losing-profile-zana-test");
  });
});
