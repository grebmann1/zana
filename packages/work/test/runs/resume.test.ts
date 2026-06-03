// Tests for packages/work/src/runs/checkpoint/resume.ts
// Covers the two pure helpers (buildResumeContext / enrichPrompt) plus
// the resume() orchestrator function with all its branches, and
// createFromTeam().  No real FS I/O — store interactions are mocked via
// vi.mock so the suite is fully deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock the store dependency before importing resume ─────────────────────
vi.mock("@zana-ai/work/src/runs/checkpoint/store.ts", () => ({
  load: vi.fn(),
  update: vi.fn(),
  save: vi.fn((data) => ({ id: "ckpt-1", ...data })),
  addPendingAgent: vi.fn(),
}));

import {
  buildResumeContext,
  enrichPrompt,
  resume,
  createFromTeam,
} from "@zana-ai/work/src/runs/checkpoint/resume.ts";
import * as store from "@zana-ai/work/src/runs/checkpoint/store.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function makeCheckpoint(overrides = {}) {
  return {
    id: "ckpt-1",
    completedAgents: [],
    pendingAgents: [],
    cwd: "/workspace",
    ...overrides,
  };
}

function makePending(overrides = {}) {
  return {
    profileId: "coder",
    prompt: "Implement the feature",
    dependencies: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildResumeContext
// ─────────────────────────────────────────────────────────────────────────

describe("buildResumeContext", () => {
  it("returns empty string when no completed agents exist", () => {
    const cp = makeCheckpoint({ completedAgents: [] });
    const pending = makePending();
    expect(buildResumeContext(cp, pending)).toBe("");
  });

  it("returns empty string when pending agent has no dependencies and completed agents have no result", () => {
    const cp = makeCheckpoint({
      completedAgents: [{ agentId: "a1", profileId: "reviewer" }],
    });
    expect(buildResumeContext(cp, makePending())).toBe("");
  });

  it("injects dependency output when dependency has a result (matched by agentId)", () => {
    const cp = makeCheckpoint({
      completedAgents: [
        { agentId: "agent-77", profileId: "researcher", profileName: "Research Bot", result: "Found 3 bugs." },
      ],
    });
    const pending = makePending({ dependencies: ["agent-77"] });
    const ctx = buildResumeContext(cp, pending);
    expect(ctx).toContain("Research Bot");
    expect(ctx).toContain("Found 3 bugs.");
    expect(ctx).toContain("Context from prior steps:");
  });

  it("injects dependency output when matched by profileId", () => {
    const cp = makeCheckpoint({
      completedAgents: [
        { agentId: "x", profileId: "architect", result: "Design doc." },
      ],
    });
    const pending = makePending({ dependencies: ["architect"] });
    const ctx = buildResumeContext(cp, pending);
    expect(ctx).toContain("Design doc.");
  });

  it("falls back to all completed-agent results when pending has no dependencies", () => {
    const cp = makeCheckpoint({
      completedAgents: [
        { agentId: "a1", profileId: "p1", result: "Result A" },
        { agentId: "a2", profileId: "p2", result: "Result B" },
      ],
    });
    const ctx = buildResumeContext(cp, makePending({ dependencies: [] }));
    expect(ctx).toContain("Result A");
    expect(ctx).toContain("Result B");
  });

  it("omits completed agents that have no result even in fallback path", () => {
    const cp = makeCheckpoint({
      completedAgents: [
        { agentId: "a1", profileId: "p1" },          // no result
        { agentId: "a2", profileId: "p2", result: "Has result" },
      ],
    });
    const ctx = buildResumeContext(cp, makePending());
    expect(ctx).toContain("Has result");
    expect(ctx).not.toContain("a1");
  });

  it("uses profileId as label when profileName is absent", () => {
    const cp = makeCheckpoint({
      completedAgents: [{ agentId: "a1", profileId: "qa-bot", result: "Tests pass." }],
    });
    const ctx = buildResumeContext(cp, makePending({ dependencies: ["qa-bot"] }));
    expect(ctx).toContain("qa-bot");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// enrichPrompt
// ─────────────────────────────────────────────────────────────────────────

describe("enrichPrompt", () => {
  it("returns the original prompt unchanged when context is empty", () => {
    expect(enrichPrompt("Do the thing", "")).toBe("Do the thing");
  });

  it("returns the original prompt unchanged when context is null/undefined", () => {
    expect(enrichPrompt("Do the thing", null)).toBe("Do the thing");
    expect(enrichPrompt("Do the thing", undefined)).toBe("Do the thing");
  });

  it("appends context to the original prompt with a blank-line separator", () => {
    const result = enrichPrompt("Do the thing", "Background info.");
    expect(result).toBe("Do the thing\n\nBackground info.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resume()
// ─────────────────────────────────────────────────────────────────────────

describe("resume()", () => {
  const mockStore = store as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when checkpoint is not found", async () => {
    mockStore.load.mockReturnValue(null);
    const result = await resume("missing-id", {}, {});
    expect(result).toMatchObject({ ok: false, error: "checkpoint not found" });
  });

  it("returns error when checkpoint has no pending agents", async () => {
    mockStore.load.mockReturnValue(makeCheckpoint({ pendingAgents: [] }));
    const result = await resume("ckpt-1", {}, {});
    expect(result).toMatchObject({ ok: false, error: "no pending agents to resume" });
  });

  it("spawns an agent for each pending entry and marks checkpoint running", async () => {
    const cp = makeCheckpoint({
      pendingAgents: [makePending({ profileId: "coder" })],
      completedAgents: [],
    });
    mockStore.load.mockReturnValue(cp);

    const fakeProfile = { id: "coder", displayName: "Coder" };
    const profileStore = { getProfile: vi.fn().mockReturnValue(fakeProfile) };
    const agentManager = { spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "spawned-99" }) };

    const result = await resume("ckpt-1", agentManager, profileStore);

    expect(result).toMatchObject({ ok: true, checkpointId: "ckpt-1" });
    expect(result.spawned).toHaveLength(1);
    expect(result.spawned[0]).toMatchObject({ agentId: "spawned-99", profileId: "coder" });
    expect(agentManager.spawnHeadlessAgent).toHaveBeenCalledOnce();
    // Final update should set status to "running" and clear pendingAgents
    const lastUpdateCall = mockStore.update.mock.calls.at(-1)[1];
    expect(lastUpdateCall).toMatchObject({ pendingAgents: [], status: "running" });
  });

  it("records an error entry when the profile for a pending agent is not found", async () => {
    const cp = makeCheckpoint({
      pendingAgents: [makePending({ profileId: "ghost-profile" })],
    });
    mockStore.load.mockReturnValue(cp);

    const profileStore = { getProfile: vi.fn().mockReturnValue(null) };
    const agentManager = { spawnHeadlessAgent: vi.fn() };

    const result = await resume("ckpt-1", agentManager, profileStore);

    expect(result.ok).toBe(true);
    expect(result.spawned[0]).toMatchObject({
      profileId: "ghost-profile",
      error: expect.stringContaining("profile not found"),
    });
    expect(agentManager.spawnHeadlessAgent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// createFromTeam()
// ─────────────────────────────────────────────────────────────────────────

describe("createFromTeam()", () => {
  const mockStore = store as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.save.mockImplementation((data: any) => ({ id: "ckpt-new", ...data }));
  });

  it("saves a checkpoint with status 'running' and returns it", () => {
    const cp = createFromTeam("team-42", "My Team", "orchestrator-1", "/projects/foo");
    expect(mockStore.save).toHaveBeenCalledOnce();
    expect(cp).toMatchObject({
      teamId: "team-42",
      teamName: "My Team",
      orchestratorAgentId: "orchestrator-1",
      cwd: "/projects/foo",
      status: "running",
      completedAgents: [],
      pendingAgents: [],
    });
    expect(typeof cp.runId).toBe("string");
    expect(cp.runId.length).toBeGreaterThan(0);
  });

  it("falls back to process.env.HOME when cwd is not provided", () => {
    createFromTeam("t1", "T", "orch", null);
    const saved = mockStore.save.mock.calls[0][0];
    expect(saved.cwd).toBe(process.env.HOME);
  });
});
