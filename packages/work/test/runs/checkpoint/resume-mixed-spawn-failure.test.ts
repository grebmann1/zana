// Focused test for the partial-failure branch of resume() in
// packages/work/src/runs/checkpoint/resume.ts.
//
// The existing resume() suite (test/runs/resume.test.ts) covers two cases in
// ISOLATION:
//   - all pending agents have a valid profile → every one spawns, and
//   - a single pending agent whose profile is missing → one error entry.
//
// Neither pins the MIXED case: when resume() processes several pending agents
// in one call and ONE of them has a missing profile, the loop must `continue`
// past it (recording an error entry) WITHOUT aborting the resume of its valid
// siblings. The robustness invariant: a single missing profile cannot strand
// the rest of a team mid-resume. This test locks:
//   - both a valid and a missing-profile pending agent are processed,
//   - spawnHeadlessAgent / addPendingAgent run ONLY for the valid agent,
//   - the spawned[] array reports the error and the success entries in order,
//   - the checkpoint still flips to "running" at the end.
//
// The store is mocked, so the test is fully deterministic — no FS, no agents.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@zana-ai/work/src/runs/checkpoint/store.ts", () => ({
  load: vi.fn(),
  update: vi.fn(),
  save: vi.fn(),
  addPendingAgent: vi.fn(),
}));

import { resume } from "@zana-ai/work/src/runs/checkpoint/resume.ts";
import * as store from "@zana-ai/work/src/runs/checkpoint/store.ts";

const mockStore = store as any;

describe("resume() — mixed valid + missing-profile pending agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns the valid agent and records an error for the missing-profile one without aborting", async () => {
    mockStore.load.mockReturnValue({
      id: "ckpt-mix",
      cwd: "/workspace",
      completedAgents: [],
      pendingAgents: [
        // Missing profile comes FIRST: if it aborted the loop, the valid
        // sibling after it would never spawn.
        { profileId: "ghost-profile", prompt: "p-ghost", dependencies: [] },
        { profileId: "coder", prompt: "p-coder", dependencies: [] },
      ],
    });

    const fakeProfile = { id: "coder", displayName: "Coder" };
    const profileStore = {
      getProfile: vi.fn((id: string) => (id === "coder" ? fakeProfile : null)),
    };
    const agentManager = {
      spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "spawned-coder" }),
    };

    const result = await resume("ckpt-mix", agentManager, profileStore);

    expect(result.ok).toBe(true);

    // Both pending entries are reported, in original order.
    expect(result.spawned).toHaveLength(2);
    expect(result.spawned[0]).toMatchObject({
      profileId: "ghost-profile",
      error: expect.stringContaining("profile not found"),
    });
    expect(result.spawned[1]).toMatchObject({
      agentId: "spawned-coder",
      profileId: "coder",
    });

    // The valid sibling DID spawn despite the earlier missing profile.
    expect(agentManager.spawnHeadlessAgent).toHaveBeenCalledOnce();
    // addPendingAgent runs only for the successfully spawned agent.
    expect(mockStore.addPendingAgent).toHaveBeenCalledOnce();
    expect(mockStore.addPendingAgent.mock.calls[0][1]).toMatchObject({
      agentId: "spawned-coder",
      profileId: "coder",
    });

    // Resume still completes: final update flips to "running" and clears pending.
    const lastUpdate = mockStore.update.mock.calls.at(-1)[1];
    expect(lastUpdate).toMatchObject({ pendingAgents: [], status: "running" });
  });
});
