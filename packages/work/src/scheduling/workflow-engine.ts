import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
function _core() { return require("@zana/core"); }
function _bus() { return _core().events.bus; }
function _workspaceContext() { return _core().project.workspaceContext; }

export const MAX_STEPS = 10;
export const MAX_CONCURRENT_RUNS = 3;

const activeRuns = new Map();

function getWorkflowsDir() {
  const paths = _workspaceContext().getProjectPaths();
  const dir = path.join(paths.projectDir, "workflows");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function persistRun(run) {
  const dir = getWorkflowsDir();
  fs.writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");
}

export function loadRun(runId) {
  const dir = getWorkflowsDir();
  const fpath = path.join(dir, `${runId}.json`);
  try {
    return JSON.parse(fs.readFileSync(fpath, "utf8"));
  } catch {
    return null;
  }
}

export function listRuns(filter = {}) {
  const dir = getWorkflowsDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
      })
      .filter(Boolean)
      .filter((r) => !filter.status || r.status === filter.status);
  } catch {
    return [];
  }
}

export function evaluateCondition(condition, context) {
  if (!condition) return true;
  try {
    const { ticket, agent, run } = context;
    const fn = new Function("ticket", "agent", "run", `return (${condition});`);
    return !!fn(ticket || {}, agent || {}, run || {});
  } catch (err) {
    process.stderr.write(`[workflow-engine] condition eval failed: ${err.message}\n`);
    return false;
  }
}

function interpolatePrompt(template, context) {
  if (!template) return "";
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, keyPath) => {
    const parts = keyPath.split(".");
    let val = context;
    for (const p of parts) {
      val = val?.[p];
    }
    return val != null ? String(val) : "";
  });
}

export async function executeWorkflow(skill, triggerContext = {}) {
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    process.stderr.write(`[workflow-engine] max concurrent runs (${MAX_CONCURRENT_RUNS}) reached, skipping\n`);
    return { error: "max_concurrent_runs" };
  }

  const steps = skill.steps || [];
  if (steps.length === 0) return { error: "no_steps" };
  if (steps.length > MAX_STEPS) {
    process.stderr.write(`[workflow-engine] workflow ${skill.id} has ${steps.length} steps (max ${MAX_STEPS})\n`);
    return { error: "too_many_steps" };
  }

  const run = {
    id: crypto.randomUUID(),
    skillId: skill.id,
    skillName: skill.name,
    status: "running",
    currentStep: 0,
    steps: steps.map((s, i) => ({ index: i, ...s, status: "pending", result: null })),
    triggerContext,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  activeRuns.set(run.id, run);
  persistRun(run);
  bus.emit("workflow:started", { runId: run.id, skillId: skill.id, skillName: skill.name });

  try {
    for (let i = 0; i < run.steps.length; i++) {
      run.currentStep = i;
      const step = run.steps[i];
      step.status = "running";
      persistRun(run);
      bus.emit("workflow:step", { runId: run.id, step: i, action: step.action });

      const context = { ...triggerContext, run: { id: run.id, step: i } };
      const result = await executeStep(step, context);

      if (result.halted) {
        step.status = "halted";
        step.result = result;
        run.status = "halted";
        run.completedAt = new Date().toISOString();
        persistRun(run);
        bus.emit("workflow:halted", { runId: run.id, step: i, reason: result.reason });
        return run;
      }

      step.status = "completed";
      step.result = result;
      persistRun(run);
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    persistRun(run);
    bus.emit("workflow:completed", { runId: run.id, skillId: skill.id });
    return run;
  } catch (err) {
    run.status = "failed";
    run.error = err.message;
    run.completedAt = new Date().toISOString();
    persistRun(run);
    bus.emit("workflow:failed", { runId: run.id, error: err.message });
    return run;
  } finally {
    activeRuns.delete(run.id);
  }
}

async function executeStep(step, context) {
  switch (step.action) {
    case "spawn": {
      if (step.condition && !evaluateCondition(step.condition, context)) {
        return { halted: true, reason: `condition not met: ${step.condition}` };
      }
      const agentManager = _core().agents.manager;
      const profileStore = _core().agents.profileStore;
      const profileId = step.profile || step.profileId;
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };

      const prompt = interpolatePrompt(step.prompt || "", context);
      const cwd = _workspaceContext().isInitialized() ? _workspaceContext().getWorkspaceRoot() : process.env.HOME;
      const { agentId } = agentManager.spawnHeadlessAgent(profile, { prompt, cwd });
      return { agentId, profileId, prompt: prompt.slice(0, 100) };
    }

    case "gate": {
      const passed = evaluateCondition(step.condition, context);
      if (!passed) {
        return { halted: true, reason: `gate failed: ${step.condition}` };
      }
      return { passed: true };
    }

    case "notify": {
      const eventBusService = _core().events.service;
      const payload = step.payload ? interpolatePrompt(JSON.stringify(step.payload), context) : "{}";
      let parsedPayload;
      try { parsedPayload = JSON.parse(payload); } catch { parsedPayload = { raw: payload }; }
      eventBusService.emit(step.eventType || "workflow:notification", parsedPayload, step.tags || []);
      return { emitted: step.eventType || "workflow:notification" };
    }

    case "wait": {
      const ms = Math.min(step.durationMs || 5000, 30000);
      await new Promise((r) => setTimeout(r, ms));
      return { waited: ms };
    }

    default:
      return { error: `unknown action: ${step.action}` };
  }
}

