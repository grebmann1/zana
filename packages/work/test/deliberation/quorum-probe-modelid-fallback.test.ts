// Focused test for the Voter.modelId fallback in runProbes (quorum.ts, ~L312).
//
// On a SUCCESSFUL probe (ok:true) the voter's recorded modelId is:
//   - result.modelId            when it is a non-empty string;
//   - else c.profile.model      when the probe omits/blanks the model;
//   - else the literal "unknown" when the profile carries no model either.
//
// Every existing quorum suite stubs a successful probe that always returns a
// non-empty modelId (sourced from profile.model), so the two fallback arms were
// untested. This matters for audit fidelity: a council record must always name
// SOME model for each seated voter, never undefined/empty.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as quorum from "@zana-ai/work/src/deliberation/quorum.ts";

describe("quorum runProbes — Voter.modelId fallback on successful probe", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-quorum-modelid-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("falls back to the profile's declared model, then to \"unknown\", when the probe returns no modelId", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });

    // Both probes succeed but return an empty/missing modelId, forcing the
    // fallback. Candidate "a"'s profile declares a model; "b"'s does not.
    const probeAgent = async (profile: any) => ({
      ok: true,
      latencyMs: 10,
      failures: [],
      modelId: profile.id === "a" ? "" : undefined, // empty + missing both blank
      probeId: "probe-" + profile.id,
      legs: [],
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: { id: "a", model: "claude-haiku" } },
        { profileId: "b", profile: { id: "b" } }, // no declared model
      ],
      deps: { probeAgent },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;

    const byProfile = Object.fromEntries(outcome.voters.map((v) => [v.profileId, v]));
    // Empty probe modelId → fall back to the profile's declared model.
    expect(byProfile.a.modelId).toBe("claude-haiku");
    // Missing probe modelId AND no declared model → literal "unknown".
    expect(byProfile.b.modelId).toBe("unknown");

    // The same fallback is persisted on the deliberation record, not just the
    // returned outcome.
    const reloaded = run.loadDeliberation(d.id)!;
    const persisted = Object.fromEntries(reloaded.voters.map((v) => [v.profileId, v]));
    expect(persisted.a.modelId).toBe("claude-haiku");
    expect(persisted.b.modelId).toBe("unknown");
  });
});
