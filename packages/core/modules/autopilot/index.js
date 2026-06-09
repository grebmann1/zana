// Goal-driven autopilot — sequence agents toward a goal, evaluate after each pass.
const goals = new Map(); // goalId -> { id, title, criteria, steps, iteration, status, results, createdAt }
let logFn = (msg) => console.error("[autopilot]", msg);
let busRef = null;
let configRef = {};
// Captured at init() from ctx — the canonical agent kill seam. Falls back to
// requiring @zana-ai/core when ctx didn't provide one (older module-loader
// versions). Tests inject via ctx.swarm.agents.kill so the call is observable.
let killAgentFn = (agentId) => {
  try {
    const am = require("@zana-ai/core").agents.manager;
    am.killAgent(agentId);
  } catch (err) {
    logFn(`killAgent(${agentId}) fallback failed: ${err?.message || err}`);
  }
};

async function setGoal(payload) {
  const goalId = require("node:crypto").randomUUID();
  const goal = {
    id: goalId,
    title: payload.title,
    criteria: payload.criteria,
    steps: payload.steps,
    iteration: 0,
    status: "running",
    results: [],
    createdAt: Date.now(),
  };
  goals.set(goalId, goal);
  busRef?.emit("autopilot:goal_started", { goalId, title: goal.title });
  // Run loop async — return immediately with goalId
  runGoal(goalId).catch((err) => logFn(`goal ${goalId} crashed: ${err.message}`));
  return { goalId, status: "running" };
}

async function runGoal(goalId) {
  const goal = goals.get(goalId);
  if (!goal) return;
  const am = require("@zana-ai/core").agents.manager;
  const ps = require("@zana-ai/core").agents.profileStore;
  const evaluatorProfileId = configRef.evaluatorProfile || "code-reviewer";
  const maxIter = configRef.maxIterations ?? 5;

  while (goal.iteration < maxIter && goal.status === "running") {
    goal.iteration++;
    logFn(`goal ${goalId} iteration ${goal.iteration}/${maxIter}`);
    goal.results = [];

    // Run each step in sequence
    for (let i = 0; i < goal.steps.length; i++) {
      const step = goal.steps[i];
      const profile = ps.getProfile(step.profile);
      if (!profile) {
        goal.status = "failed";
        goal.failureReason = `unknown profile: ${step.profile}`;
        busRef?.emit("autopilot:goal_failed", { goalId, reason: goal.failureReason });
        return;
      }
      const augmented = goal.results.length > 0
        ? step.prompt + "\n\nPrior step results:\n" + goal.results.map((r, idx) => `Step ${idx+1}: ${r.summary}`).join("\n")
        : step.prompt;
      const { agentId } = am.spawnHeadlessAgent(profile, { prompt: augmented });
      // Track the in-flight agent so cancelGoal can SIGTERM it. Without this,
      // cancel only flipped status — billed compute kept running to completion.
      goal.currentAgentId = agentId;
      const output = await waitForAgent(am, agentId, 600000); // 10 min timeout per step
      goal.currentAgentId = null;
      // The wait may have returned because cancelGoal killed the agent; if so,
      // bail out of the loop instead of recording the partial step.
      if (goal.status !== "running") return;
      goal.results.push({ step: i, agentId, summary: output?.slice(0, 1000) || "(no output)" });
      busRef?.emit("autopilot:step_completed", { goalId, step: i, agentId });
    }

    // Evaluate criteria
    const evalProfile = ps.getProfile(evaluatorProfileId);
    if (!evalProfile) {
      goal.status = "failed";
      goal.failureReason = `evaluator profile not found: ${evaluatorProfileId}`;
      busRef?.emit("autopilot:goal_failed", { goalId, reason: goal.failureReason });
      return;
    }
    const evalPrompt = [
      `Goal: ${goal.title}`,
      `Success criteria: ${goal.criteria}`,
      ``,
      `Evidence from this iteration:`,
      goal.results.map((r, idx) => `Step ${idx+1} (${goal.steps[idx]?.profile}): ${r.summary}`).join("\n\n"),
      ``,
      `Reply with EXACTLY one line starting with "VERDICT: PASS" or "VERDICT: FAIL". On FAIL, follow with a "Reason:" line explaining what's missing.`,
    ].join("\n");
    const { agentId: evalAgentId } = am.spawnHeadlessAgent(evalProfile, { prompt: evalPrompt });
    goal.currentAgentId = evalAgentId;
    const evalOutput = (await waitForAgent(am, evalAgentId, 300000)) || "";
    goal.currentAgentId = null;
    if (goal.status !== "running") return;
    const passed = /VERDICT:\s*PASS/i.test(evalOutput);
    goal.lastEvaluation = evalOutput.slice(0, 2000);
    if (passed) {
      goal.status = "completed";
      goal.completedAt = Date.now();
      busRef?.emit("autopilot:goal_completed", { goalId, iterations: goal.iteration });
      return;
    }
    logFn(`goal ${goalId} iteration ${goal.iteration} did not pass criteria; restarting from step 0`);
  }

  if (goal.status === "running") {
    goal.status = "exhausted";
    goal.failureReason = `exceeded max iterations (${maxIter})`;
    busRef?.emit("autopilot:goal_failed", { goalId, reason: goal.failureReason });
  }
}

async function waitForAgent(am, agentId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const a = am.getAgent(agentId);
    if (!a) return null;
    if (a.state === "terminated" || a.state === "errored" || a.state === "error") {
      return a.result || null;
    }
  }
  // Timeout — kill it
  try { am.killAgent(agentId); } catch {}
  return null;
}

function getGoal(goalId) {
  const g = goals.get(goalId);
  if (!g) return null;
  return { ...g };
}

function listGoals(filter = {}) {
  const out = [];
  for (const g of goals.values()) {
    if (filter.status && g.status !== filter.status) continue;
    out.push({ id: g.id, title: g.title, status: g.status, iteration: g.iteration, createdAt: g.createdAt });
  }
  return out;
}

function cancelGoal(goalId) {
  const g = goals.get(goalId);
  if (!g) return { ok: false, error: "unknown goal" };
  if (g.status !== "running") return { ok: false, error: `goal already ${g.status}` };
  // Kill the in-flight step's spawned agent FIRST. Without this, cancel was
  // only an observability lie — billed compute kept running to completion
  // (CWE-400/770: denial-of-wallet). The runGoal loop checks goal.status
  // after waitForAgent returns and bails out without recording results.
  if (g.currentAgentId) {
    try {
      killAgentFn(g.currentAgentId);
    } catch (err) {
      logFn(`cancelGoal ${goalId}: killAgent(${g.currentAgentId}) failed: ${err?.message || err}`);
    }
  }
  g.status = "cancelled";
  g.failureReason = "cancelled by user";
  busRef?.emit("autopilot:goal_failed", { goalId, reason: "cancelled" });
  return { ok: true };
}

// Test seam — directly plant a currentAgentId on a goal so unit tests can
// exercise the cancelGoal-kills-in-flight path without driving runGoal's
// async loop. NOT for production use.
function _setGoalCurrentAgentForTest(goalId, agentId) {
  const g = goals.get(goalId);
  if (!g) return false;
  g.currentAgentId = agentId;
  return true;
}

module.exports = {
  async init(ctx) {
    logFn = (msg) => ctx.logger.info(msg);
    busRef = ctx.bus;
    configRef = ctx.config || {};
    // Prefer the loader-injected kill seam so cancelGoal's invocation is
    // observable from tests (vi.mock can't intercept CJS require chains).
    if (ctx?.swarm?.agents?.kill && typeof ctx.swarm.agents.kill === "function") {
      killAgentFn = ctx.swarm.agents.kill;
    }
    ctx.logger.info("autopilot module ready");
    return {
      setGoal,
      getGoal,
      listGoals,
      cancelGoal,
      _setGoalCurrentAgentForTest,
    };
  },
  async recover(_state, ctx) {
    ctx.logger.info("autopilot recovered (in-memory goals are lost across restarts — by design v1)");
  },
  async suspend() { console.error("[autopilot] suspending"); },
  async shutdown() { console.error("[autopilot] shutting down"); },
};
