import * as crypto from "node:crypto";
import * as store from "./store.ts";

export function buildResumeContext(checkpoint, pendingAgent) {
  const contextParts = [];

  if (pendingAgent.dependencies && pendingAgent.dependencies.length > 0) {
    const completed = checkpoint.completedAgents || [];
    for (const depId of pendingAgent.dependencies) {
      const dep = completed.find((c) => c.agentId === depId || c.profileId === depId);
      if (dep && dep.result) {
        const label = dep.profileName || dep.profileId || dep.agentId;
        contextParts.push(`--- Output from ${label} ---\n${dep.result}\n---`);
      }
    }
  }

  if (contextParts.length === 0 && checkpoint.completedAgents?.length > 0) {
    for (const agent of checkpoint.completedAgents) {
      if (agent.result) {
        const label = agent.profileName || agent.profileId || agent.agentId;
        contextParts.push(`--- Output from ${label} ---\n${agent.result}\n---`);
      }
    }
  }

  return contextParts.length > 0
    ? `Context from prior steps:\n\n${contextParts.join("\n\n")}`
    : "";
}

export function enrichPrompt(originalPrompt, context) {
  if (!context) return originalPrompt;
  return `${originalPrompt}\n\n${context}`;
}

export async function resume(checkpointId, agentManager, profileStore) {
  const checkpoint = store.load(checkpointId);
  if (!checkpoint) return { ok: false, error: "checkpoint not found" };

  const pending = checkpoint.pendingAgents || [];
  if (pending.length === 0) {
    return { ok: false, error: "no pending agents to resume" };
  }

  const newRunId = crypto.randomUUID();
  store.update(checkpointId, {
    status: "resumed",
    resumedAt: Date.now(),
    resumeRunId: newRunId,
  });

  const spawned = [];

  for (const pendingAgent of pending) {
    const profile = profileStore.getProfile(pendingAgent.profileId);
    if (!profile) {
      spawned.push({
        profileId: pendingAgent.profileId,
        error: `profile not found: ${pendingAgent.profileId}`,
      });
      continue;
    }

    const context = buildResumeContext(checkpoint, pendingAgent);
    const prompt = enrichPrompt(pendingAgent.prompt, context);

    const { agentId } = agentManager.spawnHeadlessAgent(profile, {
      prompt,
      cwd: checkpoint.cwd || process.env.HOME,
      parentAgentId: pendingAgent.parentAgentId || null,
    });

    store.addPendingAgent(checkpointId, {
      agentId,
      profileId: pendingAgent.profileId,
      prompt: pendingAgent.prompt,
      parentAgentId: pendingAgent.parentAgentId,
      dependencies: pendingAgent.dependencies,
    });

    spawned.push({ agentId, profileId: pendingAgent.profileId });
  }

  store.update(checkpointId, {
    pendingAgents: [],
    status: "running",
  });

  return { ok: true, checkpointId, runId: newRunId, spawned };
}

export function createFromTeam(teamId, teamName, orchestratorAgentId, cwd) {
  const checkpoint = store.save({
    teamId,
    teamName,
    runId: crypto.randomUUID(),
    status: "running",
    orchestratorAgentId,
    cwd: cwd || process.env.HOME,
    completedAgents: [],
    pendingAgents: [],
  });
  return checkpoint;
}

