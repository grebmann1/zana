import * as crypto from "node:crypto";
function _core() { return require("@zana-ai/core"); }
function _agentManager(): any { return _core().agents.manager; }
function _profileStore(): any { return _core().agents.profileStore; }
function _bus(): any { return _core().events.bus; }
function _EVENTS(): any { return _core().events.EVENTS; }

const plans = new Map();
const actionRegistry = new Map();

const GOAL_KEYWORDS = {
  requirementsAnalyzed: ["requirement", "spec", "scope", "define", "analyze", "analysis"],
  architectureDesigned: ["architect", "design", "structure", "system", "diagram"],
  codeWritten: ["implement", "code", "build", "develop", "create", "feature", "write code"],
  testsWritten: ["test", "spec", "coverage", "unit test", "integration test"],
  codeReviewed: ["review", "quality", "check", "audit", "inspect"],
  issuesFixed: ["fix", "bug", "issue", "resolve", "patch", "repair"],
};

const DEFAULT_ACTIONS = [
  { id: "analyze-requirements", name: "Analyze Requirements", preconditions: {},
    effects: { requirementsAnalyzed: true }, cost: 2, profileId: "architect",
    promptTemplate: "Analyze the requirements for the following goal and produce a clear specification:\n\n{goal}" },
  { id: "design-architecture", name: "Design Architecture", preconditions: { requirementsAnalyzed: true },
    effects: { architectureDesigned: true }, cost: 3, profileId: "architect",
    promptTemplate: "Design the architecture for the following specification. Produce file structure, interfaces, and data flow:\n\n{goal}" },
  { id: "implement-code", name: "Implement Code", preconditions: { architectureDesigned: true },
    effects: { codeWritten: true }, cost: 5, profileId: "backend-dev",
    promptTemplate: "Implement the code according to the architecture design for:\n\n{goal}" },
  { id: "write-tests", name: "Write Tests", preconditions: { codeWritten: true },
    effects: { testsWritten: true }, cost: 3, profileId: "test-writer",
    promptTemplate: "Write comprehensive tests for the implementation of:\n\n{goal}" },
  { id: "review-code", name: "Review Code", preconditions: { codeWritten: true },
    effects: { codeReviewed: true }, cost: 2, profileId: "code-reviewer",
    promptTemplate: "Review the code implementation for quality, correctness, and best practices:\n\n{goal}" },
  { id: "fix-issues", name: "Fix Issues", preconditions: { codeReviewed: true, testsWritten: true },
    effects: { issuesFixed: true }, cost: 4, profileId: "full-auto-coder",
    promptTemplate: "Fix any issues found during code review and ensure all tests pass:\n\n{goal}" },
];

function init() {
  for (const action of DEFAULT_ACTIONS) actionRegistry.set(action.id, action);
}

export function registerAction(action) {
  if (!action.id || !action.effects || !action.profileId) {
    throw new Error("Action requires id, effects, and profileId");
  }
  actionRegistry.set(action.id, { preconditions: {}, cost: 1, promptTemplate: "{goal}", ...action });
}

function parseGoalState(goalDescription) {
  const desc = goalDescription.toLowerCase();
  const goalState = {};
  for (const [key, keywords] of Object.entries(GOAL_KEYWORDS)) {
    for (const kw of keywords) {
      if (desc.includes(kw)) { goalState[key] = true; break; }
    }
  }
  if (Object.keys(goalState).length === 0) {
    goalState.codeWritten = true;
    goalState.testsWritten = true;
    goalState.codeReviewed = true;
  }
  return goalState;
}

function statesSatisfied(required, current) {
  for (const [key, val] of Object.entries(required)) {
    if (current[key] !== val) return false;
  }
  return true;
}

function buildInitialState(goalState) {
  const state = {};
  for (const key of Object.keys(goalState)) state[key] = false;
  for (const action of actionRegistry.values()) {
    for (const key of Object.keys(action.preconditions || {})) {
      if (!(key in state)) state[key] = false;
    }
  }
  return state;
}

function stateKey(state) {
  return JSON.stringify(Object.entries(state).sort((a, b) => a[0].localeCompare(b[0])));
}

function aStarPlan(initialState, goalState) {
  const actions = Array.from(actionRegistry.values());
  const openSet = [{ state: initialState, actions: [], cost: 0 }];
  const visited = new Set([stateKey(initialState)]);

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.cost - b.cost);
    const current = openSet.shift();

    if (statesSatisfied(goalState, current.state)) return current.actions;

    for (const action of actions) {
      if (!statesSatisfied(action.preconditions || {}, current.state)) continue;
      let hasNewEffect = false;
      for (const [k, v] of Object.entries(action.effects)) {
        if (current.state[k] !== v) { hasNewEffect = true; break; }
      }
      if (!hasNewEffect) continue;

      const newState = { ...current.state, ...action.effects };
      const key = stateKey(newState);
      if (visited.has(key)) continue;
      visited.add(key);
      openSet.push({ state: newState, actions: [...current.actions, action], cost: current.cost + action.cost });
    }
  }
  return null;
}

function buildDAG(actionSequence) {
  const layers = [];
  const completed = {};
  let remaining = [...actionSequence];

  while (remaining.length > 0) {
    const layer = [];
    const deferred = [];
    for (const action of remaining) {
      if (statesSatisfied(action.preconditions || {}, completed)) layer.push(action);
      else deferred.push(action);
    }
    if (layer.length === 0) {
      layer.push(deferred.shift());
      remaining = deferred;
    } else {
      remaining = deferred;
    }
    layers.push(layer);
    for (const action of layer) Object.assign(completed, action.effects);
  }
  return layers;
}

export function createPlan(goalDescription, options = {}) {
  if (!actionRegistry.size) init();

  const goalState = options.goalState || parseGoalState(goalDescription);
  const initialState = options.initialState || buildInitialState(goalState);
  const actionSequence = aStarPlan(initialState, goalState);
  if (!actionSequence || actionSequence.length === 0) {
    throw new Error("No valid plan found for goal: " + goalDescription);
  }

  const layers = buildDAG(actionSequence);
  const estimatedCost = actionSequence.reduce((sum, a) => sum + a.cost, 0);
  const planId = crypto.randomUUID();

  const plan = {
    planId, goalDescription, goalState, initialState,
    currentState: { ...initialState }, layers, currentLayer: 0,
    state: "created", progress: 0, estimatedCost,
    actions: actionSequence.map((a) => ({
      id: a.id, name: a.name, profileId: a.profileId,
      status: "pending", agentId: null, result: null,
    })),
    createdAt: Date.now(), options,
  };

  plans.set(planId, plan);
  _bus().emit("plan:created", { planId, layers: layers.length, estimatedCost, goal: goalDescription });
  return { planId, layers, estimatedCost };
}

function waitForAgent(agentId) {
  return new Promise((resolve) => {
    const agent = _agentManager().getAgent(agentId);
    if (agent && (agent.state === "terminated" || agent.state === "errored")) {
      resolve(agent);
      return;
    }
    const bus = _bus();
    const EVENTS = _EVENTS();
    const handler = (payload) => {
      if (payload.agentId === agentId) {
        bus.removeListener(EVENTS.AGENT_TERMINATED, handler);
        resolve(_agentManager().getAgent(agentId));
      }
    };
    bus.on(EVENTS.AGENT_TERMINATED, handler);
  });
}

async function executeLayer(plan, layerIndex) {
  const layer = plan.layers[layerIndex];
  const cwd = plan.options.cwd || process.env.HOME;

  const tasks = layer.map((action) => {
    const profile = _profileStore().getProfile(action.profileId);
    if (!profile) throw new Error(`Profile not found: ${action.profileId}`);
    const prompt = action.promptTemplate.replace(/\{goal\}/g, plan.goalDescription);
    const { agentId } = _agentManager().spawnHeadlessAgent(profile, { prompt, cwd });

    const planAction = plan.actions.find((a) => a.id === action.id && a.status === "pending");
    if (planAction) { planAction.status = "running"; planAction.agentId = agentId; }

    return waitForAgent(agentId).then((agent) => {
      if (planAction) {
        planAction.status = agent.state === "terminated" ? "completed" : "failed";
        planAction.result = agent.result;
      }
      return { action, agent };
    });
  });

  const results = await Promise.all(tasks);
  for (const { action, agent } of results) {
    if (agent.state === "terminated") Object.assign(plan.currentState, action.effects);
  }
  return { results, failed: results.filter((r) => r.agent.state !== "terminated") };
}

export async function executePlan(planId) {
  const plan = plans.get(planId);
  if (!plan) throw new Error("Plan not found: " + planId);
  if (plan.state === "running") throw new Error("Plan already running: " + planId);

  plan.state = "running";
  _bus().emit("plan:started", { planId });
  const allResults = [];

  try {
    for (let i = plan.currentLayer; i < plan.layers.length; i++) {
      plan.currentLayer = i;
      plan.progress = Math.round((i / plan.layers.length) * 100);
      const { results, failed } = await executeLayer(plan, i);
      allResults.push(...results);
      _bus().emit("plan:layer-complete", { planId, layer: i, failed: failed.length });

      if (failed.length > 0) {
        const replanned = replan(planId);
        if (!replanned.success) {
          plan.state = "failed";
          _bus().emit("plan:failed", { planId, layer: i, reason: "replan failed" });
          return { success: false, results: allResults };
        }
        i = plan.currentLayer - 1;
      }
    }
    plan.state = "completed";
    plan.progress = 100;
    _bus().emit("plan:completed", { planId, totalActions: allResults.length });
    return { success: true, results: allResults };
  } catch (err) {
    plan.state = "failed";
    _bus().emit("plan:failed", { planId, reason: err.message });
    return { success: false, results: allResults, error: err.message };
  }
}

export function getPlanStatus(planId) {
  const plan = plans.get(planId);
  if (!plan) return null;
  return {
    planId: plan.planId, state: plan.state, currentLayer: plan.currentLayer,
    progress: plan.progress, actions: plan.actions,
  };
}

export function listPlans() {
  return Array.from(plans.values()).map((p) => ({
    planId: p.planId, state: p.state, goal: p.goalDescription,
    progress: p.progress, createdAt: p.createdAt,
  }));
}

export function cancelPlan(planId) {
  const plan = plans.get(planId);
  if (!plan || plan.state === "completed" || plan.state === "cancelled") return false;
  for (const action of plan.actions) {
    if (action.status === "running" && action.agentId) {
      _agentManager().killAgent(action.agentId);
      action.status = "cancelled";
    }
  }
  plan.state = "cancelled";
  _bus().emit("plan:failed", { planId, reason: "cancelled" });
  return true;
}

export function replan(planId) {
  const plan = plans.get(planId);
  if (!plan) return { success: false };

  const remainingGoal = {};
  for (const [key, val] of Object.entries(plan.goalState)) {
    if (plan.currentState[key] !== val) remainingGoal[key] = val;
  }
  if (Object.keys(remainingGoal).length === 0) return { success: true, newLayers: [] };

  const actionSequence = aStarPlan(plan.currentState, remainingGoal);
  if (!actionSequence || actionSequence.length === 0) return { success: false };

  const newLayers = buildDAG(actionSequence);
  plan.layers = [...plan.layers.slice(0, plan.currentLayer), ...newLayers];

  for (const action of actionSequence) {
    const existing = plan.actions.find((a) => a.id === action.id && a.status === "failed");
    if (existing) {
      existing.status = "pending";
      existing.agentId = null;
      existing.result = null;
    } else {
      plan.actions.push({
        id: action.id, name: action.name, profileId: action.profileId,
        status: "pending", agentId: null, result: null,
      });
    }
  }
  _bus().emit("plan:replanned", { planId, newLayers: newLayers.length });
  return { success: true, newLayers };
}

init();

