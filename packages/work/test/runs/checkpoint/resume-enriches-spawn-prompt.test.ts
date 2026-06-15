// Focused test for an untested integration behavior of resume() in
// packages/work/src/runs/checkpoint/resume.ts.
//
// resume()'s whole purpose is to hand a re-spawned pending agent the OUTPUT of
// the dependencies it was waiting on. Internally it calls buildResumeContext()
// + enrichPrompt() and passes the *enriched* prompt to spawnHeadlessAgent().
//
// The pure helpers buildResumeContext()/enrichPrompt() are unit-tested in
// isolation, and resume()'s status transitions + spawn count are covered
// elsewhere — but nothing asserts that the enriched prompt actually REACHES the
// agent manager. A regression that spawned with the bare `pendingAgent.prompt`
// (dropping prior-step context) would pass every existing test. This locks the
// wiring: dependency output → enriched prompt → spawnHeadlessAgent.
//
// The store is mocked, so the test is deterministic — no FS, no real agents.
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

describe("resume() — enriches the spawn prompt with dependency output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a prompt containing the completed dependency's result to spawnHeadlessAgent", async () => {
    mockStore.load.mockReturnValue({
      id: "ckpt-1",
      cwd: "/workspace",
      completedAgents: [
        {
          agentId: "researcher-1",
          profileName: "Researcher",
          result: "FINDINGS: use a queue.",
        },
      ],
      pendingAgents: [
        {
          profileId: "coder",
          prompt: "Implement the feature.",
          dependencies: ["researcher-1"],
          parentAgentId: "orch-1",
        },
      ],
    });
    const profileStore = { getProfile: vi.fn().mockReturnValue({ id: "coder" }) };
    const agentManager = {
      spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "spawned-1" }),
    };

    const result = await resume("ckpt-1", agentManager, profileStore);

    expect(result.ok).toBe(true);
    expect(agentManager.spawnHeadlessAgent).toHaveBeenCalledOnce();

    const [profileArg, opts] = agentManager.spawnHeadlessAgent.mock.calls[0];
    expect(profileArg).toMatchObject({ id: "coder" });
    // Original instruction is preserved...
    expect(opts.prompt).toContain("Implement the feature.");
    // ...and the dependency's output is appended under a labeled context block.
    expect(opts.prompt).toContain("Context from prior steps:");
    expect(opts.prompt).toContain("Output from Researcher");
    expect(opts.prompt).toContain("FINDINGS: use a queue.");
    // cwd + parent wiring flow through from the checkpoint / pending entry.
    expect(opts.cwd).toBe("/workspace");
    expect(opts.parentAgentId).toBe("orch-1");

    // The re-spawned agent is re-queued under its NEW agentId, preserving the
    // original (un-enriched) prompt so a later resume re-derives fresh context.
    expect(mockStore.addPendingAgent).toHaveBeenCalledWith(
      "ckpt-1",
      expect.objectContaining({
        agentId: "spawned-1",
        profileId: "coder",
        prompt: "Implement the feature.",
        dependencies: ["researcher-1"],
      }),
    );
  });
});
