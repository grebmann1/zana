// Focused test for an untested branch of resume() in
// packages/work/src/runs/checkpoint/resume.ts.
//
// When spawning each pending agent, resume() applies two fallbacks:
//   cwd:           checkpoint.cwd || process.env.HOME
//   parentAgentId: pendingAgent.parentAgentId || null
//
// Every existing resume() test supplies BOTH values explicitly
// (checkpoint.cwd === "/workspace", pendingAgent.parentAgentId === "orch-1"),
// so the falsy-fallback halves of these expressions are never exercised. This
// test drives a checkpoint with NO cwd and a pending agent with NO
// parentAgentId, and pins that spawnHeadlessAgent receives the resolved
// fallbacks (process.env.HOME and null) — not undefined.
//
// The store is mocked, so the test is fully deterministic — no FS, no agents,
// no network.
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

describe("resume() — spawn-option fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to process.env.HOME for cwd and null for parentAgentId when both are absent", async () => {
    // No `cwd` on the checkpoint; no `parentAgentId` on the pending entry.
    mockStore.load.mockReturnValue({
      id: "ckpt-fallback",
      completedAgents: [],
      pendingAgents: [{ profileId: "coder", prompt: "do it", dependencies: [] }],
    });
    const profileStore = { getProfile: vi.fn().mockReturnValue({ id: "coder" }) };
    const agentManager = {
      spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "spawned-1" }),
    };

    const result = await resume("ckpt-fallback", agentManager, profileStore);

    expect(result.ok).toBe(true);
    expect(agentManager.spawnHeadlessAgent).toHaveBeenCalledOnce();

    const [, opts] = agentManager.spawnHeadlessAgent.mock.calls[0];
    expect(opts.cwd).toBe(process.env.HOME);
    // The fallback must be an explicit null, never `undefined`.
    expect(opts.parentAgentId).toBeNull();
  });
});
