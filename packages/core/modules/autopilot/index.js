// Goal-driven autopilot — sequence agents toward a goal, evaluate after each pass.
const goals = new Map(); // goalId -> { id, title, criteria, steps, iteration, status, results, createdAt }
let logFn = (msg) => console.error("[autopilot]", msg);
let busRef = null;
let configRef = {};

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
  const am = require("@zana/core").agents.manager;
  const ps = require("@zana/core").agents.profileStore;
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
      const output = await waitForAgent(am, agentId, 600000); // 10 min timeout per step
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
    const evalOutput = (await waitForAgent(am, evalAgentId, 300000)) || "";
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
  g.status = "cancelled";
  g.failureReason = "cancelled by user";
  busRef?.emit("autopilot:goal_failed", { goalId, reason: "cancelled" });
  return { ok: true };
}

module.exports = {
  async init(ctx) {
    logFn = (msg) => ctx.logger.info(msg);
    busRef = ctx.bus;
    configRef = ctx.config || {};
    ctx.logger.info("autopilot module ready");
    return {
      setGoal,
      getGoal,
      listGoals,
      cancelGoal,
    };
  },
  async recover(_state, ctx) {
    ctx.logger.info("autopilot recovered (in-memory goals are lost across restarts — by design v1)");
  },
  async suspend() { console.error("[autopilot] suspending"); },
  async shutdown() { console.error("[autopilot] shutting down"); },
};
