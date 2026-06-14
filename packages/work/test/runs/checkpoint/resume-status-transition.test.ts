// Focused test for an untested branch of resume() in
// packages/work/src/runs/checkpoint/resume.ts.
//
// resume() performs a TWO-PHASE status transition:
//   1. up front it writes { status: "resumed", resumedAt, resumeRunId } so a
//      crash mid-resume leaves an observable "resumed" marker (not a stale
//      "running"/old state), and
//   2. after spawning it writes { pendingAgents: [], status: "running" }.
//
// The returned `runId` MUST be the same value persisted as `resumeRunId` —
// callers correlate the new run against the checkpoint via that id.
//
// The existing resume() suite (test/runs/resume.test.ts) only asserts the
// FINAL "running" update and the spawned list; nothing pins the initial
// "resumed" marker or the runId↔resumeRunId consistency. This test locks that
// contract so the intermediate transition can't be silently dropped.
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

describe("resume() — resumed→running status transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a 'resumed' marker carrying the same runId it returns, then flips to 'running'", async () => {
    mockStore.load.mockReturnValue({
      id: "ckpt-1",
      cwd: "/workspace",
      completedAgents: [],
      pendingAgents: [{ profileId: "coder", prompt: "do it", dependencies: [] }],
    });
    const profileStore = { getProfile: vi.fn().mockReturnValue({ id: "coder" }) };
    const agentManager = {
      spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "spawned-1" }),
    };

    const result = await resume("ckpt-1", agentManager, profileStore);

    expect(result.ok).toBe(true);

    // Phase 1: the FIRST update marks the checkpoint "resumed" and stamps a
    // resumeRunId — before any agent is spawned.
    const firstUpdate = mockStore.update.mock.calls[0][1];
    expect(firstUpdate.status).toBe("resumed");
    expect(typeof firstUpdate.resumeRunId).toBe("string");
    expect(firstUpdate.resumeRunId.length).toBeGreaterThan(0);
    expect(typeof firstUpdate.resumedAt).toBe("number");

    // The returned runId is exactly the persisted resumeRunId.
    expect(result.runId).toBe(firstUpdate.resumeRunId);

    // Phase 2: the LAST update flips to "running" and clears the queue.
    const lastUpdate = mockStore.update.mock.calls.at(-1)[1];
    expect(lastUpdate).toMatchObject({ status: "running", pendingAgents: [] });
  });
});
