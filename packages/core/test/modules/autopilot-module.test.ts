// Tests for packages/core/modules/autopilot/index.js
//
// Covers:
//   - init() returns the 4-method API and logs "autopilot module ready"
//   - setGoal() stores a goal and emits autopilot:goal_started
//   - getGoal() returns a goal by id; null for unknown ids
//   - getGoal() returns a snapshot (mutations don't affect stored state)
//   - listGoals() returns all goals; filters by status
//   - cancelGoal() transitions a running goal to cancelled, emits autopilot:goal_failed
//   - cancelGoal() errors for unknown id or an already-finished goal
//
// No real agents are spawned.  @zana-ai/core is mocked so runGoal's background
// loop pauses on its first waitForAgent() call (never terminates), leaving the
// synchronous state under our control throughout each test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

// ── Mock @zana-ai/core ────────────────────────────────────────────────────────
// The autopilot index.js calls require("@zana-ai/core").agents.{manager,profileStore}
// inside runGoal.  We supply a stub profile so getProfile() succeeds (preventing
// the synchronous "evaluator profile not found" short-circuit that would set
// goal.status = "failed" before setGoal() returns), and a manager whose
// spawnHeadlessAgent returns a fake agentId with getAgent() always returning
// null — the waitForAgent loop parks on `await new Promise(r=>setTimeout(r,2000))`
// and never advances during the test.
vi.mock("@zana-ai/core", () => ({
  agents: {
    manager: {
      spawnHeadlessAgent: vi.fn().mockReturnValue({ agentId: "mock-agent-001" }),
      getAgent: vi.fn().mockReturnValue(null),
      killAgent: vi.fn(),
    },
    profileStore: {
      getProfile: vi.fn().mockReturnValue({ id: "code-reviewer", name: "Code Reviewer" }),
    },
  },
}));

const MODULE_PATH = path.resolve(__dirname, "../../modules/autopilot/index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function makeCtx(cfg: Record<string, unknown> = {}) {
  const busEmits: { event: string; payload: unknown }[] = [];
  const logLines: string[] = [];
  const ctx = {
    moduleId: "autopilot",
    bus: {
      emit: (event: string, payload: unknown) => busEmits.push({ event, payload }),
      on: () => () => {},
      query: () => [],
    },
    config: { maxIterations: 2, evaluatorProfile: "code-reviewer", ...cfg },
    logger: {
      info: (msg: string) => logLines.push(msg),
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
  return { ctx, busEmits, logLines };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("autopilot module — init()", () => {
  afterEach(() => {
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  it("returns the 4-method API", async () => {
    const mod = freshModule();
    const { ctx } = makeCtx();
    const api = await mod.init(ctx);
    expect(typeof api.setGoal).toBe("function");
    expect(typeof api.getGoal).toBe("function");
    expect(typeof api.listGoals).toBe("function");
    expect(typeof api.cancelGoal).toBe("function");
  });

  it('logs "autopilot module ready"', async () => {
    const mod = freshModule();
    const { ctx, logLines } = makeCtx();
    await mod.init(ctx);
    expect(logLines.some((m) => m.includes("autopilot module ready"))).toBe(true);
  });
});

describe("autopilot module — goal lifecycle", () => {
  let api: any;
  let busEmits: { event: string; payload: any }[];

  beforeEach(async () => {
    const mod = freshModule();
    const built = makeCtx();
    busEmits = built.busEmits;
    api = await mod.init(built.ctx);
  });

  afterEach(() => {
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  // ── setGoal ──────────────────────────────────────────────────────────────

  it("setGoal() returns {goalId, status:'running'}", async () => {
    const result = await api.setGoal({ title: "Ship it", criteria: "Tests pass", steps: [] });
    expect(result.status).toBe("running");
    expect(typeof result.goalId).toBe("string");
    expect(result.goalId.length).toBeGreaterThan(0);
  });

  it("setGoal() emits autopilot:goal_started with goalId and title", async () => {
    const { goalId } = await api.setGoal({ title: "My Goal", criteria: "Done", steps: [] });
    const evt = busEmits.find((e) => e.event === "autopilot:goal_started");
    expect(evt).toBeDefined();
    expect(evt?.payload.goalId).toBe(goalId);
    expect(evt?.payload.title).toBe("My Goal");
  });

  it("each setGoal() call produces a unique goalId", async () => {
    const a = await api.setGoal({ title: "A", criteria: "a", steps: [] });
    const b = await api.setGoal({ title: "B", criteria: "b", steps: [] });
    expect(a.goalId).not.toBe(b.goalId);
  });

  // ── getGoal ──────────────────────────────────────────────────────────────

  it("getGoal() returns null for an unknown id", () => {
    expect(api.getGoal("does-not-exist")).toBeNull();
  });

  it("getGoal() returns goal data after setGoal", async () => {
    const { goalId } = await api.setGoal({ title: "Find bugs", criteria: "Zero errors", steps: [] });
    const goal = api.getGoal(goalId);
    expect(goal).not.toBeNull();
    expect(goal.id).toBe(goalId);
    expect(goal.title).toBe("Find bugs");
    expect(goal.status).toBe("running");
    // runGoal increments iteration synchronously before its first await,
    // so the counter is already ≥ 1 by the time setGoal() returns.
    expect(typeof goal.iteration).toBe("number");
  });

  it("getGoal() returns a snapshot — mutations do not affect stored state", async () => {
    const { goalId } = await api.setGoal({ title: "Snapshot test", criteria: "X", steps: [] });
    const snapshot = api.getGoal(goalId);
    snapshot.title = "MUTATED";
    expect(api.getGoal(goalId)?.title).toBe("Snapshot test");
  });

  // ── listGoals ────────────────────────────────────────────────────────────

  it("listGoals() returns an array (empty before any goals)", () => {
    expect(api.listGoals()).toEqual([]);
  });

  it("listGoals() returns all goals when no filter", async () => {
    await api.setGoal({ title: "G1", criteria: "C1", steps: [] });
    await api.setGoal({ title: "G2", criteria: "C2", steps: [] });
    expect(api.listGoals().length).toBe(2);
  });

  it("listGoals({status:'running'}) excludes cancelled goals", async () => {
    const { goalId } = await api.setGoal({ title: "G1", criteria: "C1", steps: [] });
    await api.setGoal({ title: "G2", criteria: "C2", steps: [] });
    api.cancelGoal(goalId);
    const running = api.listGoals({ status: "running" });
    expect(running.length).toBe(1);
    expect(running[0].title).toBe("G2");
  });

  it("listGoals({status:'cancelled'}) returns only cancelled goals", async () => {
    const { goalId } = await api.setGoal({ title: "Gone", criteria: "C", steps: [] });
    await api.setGoal({ title: "Still running", criteria: "C", steps: [] });
    api.cancelGoal(goalId);
    const cancelled = api.listGoals({ status: "cancelled" });
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].id).toBe(goalId);
  });

  it("listGoals() entries include id, title, status, iteration, createdAt", async () => {
    await api.setGoal({ title: "Metadata check", criteria: "Y", steps: [] });
    const [entry] = api.listGoals();
    expect(typeof entry.id).toBe("string");
    expect(entry.title).toBe("Metadata check");
    expect(entry.status).toBe("running");
    expect(typeof entry.iteration).toBe("number");
    expect(typeof entry.createdAt).toBe("number");
  });

  // ── cancelGoal ───────────────────────────────────────────────────────────

  it("cancelGoal() returns {ok:true} for a running goal", async () => {
    const { goalId } = await api.setGoal({ title: "Cancel me", criteria: "C", steps: [] });
    expect(api.cancelGoal(goalId)).toEqual({ ok: true });
  });

  it("cancelGoal() sets goal status to 'cancelled'", async () => {
    const { goalId } = await api.setGoal({ title: "Will cancel", criteria: "C", steps: [] });
    api.cancelGoal(goalId);
    expect(api.getGoal(goalId)?.status).toBe("cancelled");
  });

  it("cancelGoal() emits autopilot:goal_failed with reason='cancelled'", async () => {
    const { goalId } = await api.setGoal({ title: "Fire", criteria: "C", steps: [] });
    api.cancelGoal(goalId);
    const evt = busEmits.find(
      (e) => e.event === "autopilot:goal_failed" && e.payload.goalId === goalId,
    );
    expect(evt).toBeDefined();
    expect(evt?.payload.reason).toBe("cancelled");
  });

  it("cancelGoal() returns {ok:false} for an unknown goalId", () => {
    const result = api.cancelGoal("phantom-id");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("cancelGoal() returns {ok:false} when goal is already cancelled", async () => {
    const { goalId } = await api.setGoal({ title: "G", criteria: "C", steps: [] });
    api.cancelGoal(goalId);
    const second = api.cancelGoal(goalId);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/cancelled/i);
  });
});
