import * as teamStore from "./store";
function _core() { return require("@zana/core"); }
function _agentManager(): any { return _core().agents.manager; }
function _profileStore(): any { return _core().agents.profileStore; }
function _bus(): any { return _core().events.bus; }
function _EVENTS(): any { return _core().events.EVENTS; }
import * as checkpointStore from "../runs/checkpoint/store";
import * as checkpointResume from "../runs/checkpoint/resume";

const runningTeams = new Map();
let changeListeners = [];

_agentManager().onAgentsChange(() => {
  let changed = false;
  const allAgents = _agentManager().listAgents();

  for (const [teamId, rt] of runningTeams) {
    if (rt.status !== "running") continue;
    const orchestrator = allAgents.find((a) => a.id === rt.orchestratorAgentId);

    // Auto-checkpoint: track worker completions
    if (rt.checkpointId) {
      const workers = allAgents.filter((a) => a.parentAgentId === rt.orchestratorAgentId);
      for (const worker of workers) {
        if ((worker.state === "terminated" || worker.state === "errored") && !rt.checkpointedAgents?.has(worker.id)) {
          if (!rt.checkpointedAgents) rt.checkpointedAgents = new Set();
          rt.checkpointedAgents.add(worker.id);
          checkpointStore.addCompletedAgent(rt.checkpointId, {
            agentId: worker.id,
            profileId: worker.profileId,
            profileName: worker.profileName,
            result: worker.result || "",
            exitCode: worker.state === "terminated" ? 0 : 1,
          });
        }
      }
    }

    if (orchestrator && orchestrator.state === "terminated") {
      rt.status = "completed";
      if (rt.checkpointId) {
        checkpointStore.update(rt.checkpointId, { status: "completed" });
      }
      changed = true;
    }
  }
  if (changed) notifyChange();
});

function notifyChange() {
  const snapshot = listRunningTeams();
  for (const cb of changeListeners) {
    try { cb(snapshot); } catch {}
  }
}

export function onTeamsChange(cb) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

function buildTeamLeadDisallowedTools(team, baseProfile) {
  const disallowed = new Set(baseProfile.disallowedTools || []);

  // swarm-master delegates via zana_swarm_spawn (MCP), not Write/Edit/Bash
  // Don't restrict it — its prompt already forbids direct coding
  if (baseProfile.id === "swarm-master") {
    return [...disallowed];
  }

  if (team.rules?.orchestratorAllowedTools) {
    const defaults = ["Write", "Edit", "Bash"];
    for (const tool of defaults) {
      if (!team.rules.orchestratorAllowedTools.includes(tool)) {
        disallowed.add(tool);
      }
    }
  } else {
    disallowed.add("Write");
    disallowed.add("Edit");
    disallowed.add("Bash");
  }

  return [...disallowed];
}

function buildOrchestratorPrompt(team, workerProfiles, userPrompt) {
  const slots = team.slots || team.workerProfileIds.map((id) => ({ profileId: id, quantity: 1 }));

  const workerList = slots
    .map((slot) => {
      const profile = workerProfiles.find((p) => p.id === slot.profileId);
      if (!profile) return null;
      const qty = slot.quantity > 1 ? `${slot.quantity}x ` : "";
      return `- ${qty}${profile.icon || "🤖"} **${profile.displayName}** (id: \`${profile.id}\`): ${profile.description || "No description"}`;
    })
    .filter(Boolean)
    .join("\n");

  const totalSlots = slots.reduce((sum, s) => sum + s.quantity, 0);

  const rules = [];
  if (team.rules?.maxConcurrentWorkers) {
    rules.push(`- Max concurrent workers: ${team.rules.maxConcurrentWorkers}`);
  }
  const multiSlots = slots.filter((s) => s.quantity > 1);
  if (multiSlots.length > 0) {
    const caps = multiSlots.map((s) => {
      const p = workerProfiles.find((p2) => p2.id === s.profileId);
      return `${p?.displayName || s.profileId}: max ${s.quantity}`;
    }).join(", ");
    rules.push(`- Per-role caps: ${caps}`);
  }
  if (team.rules?.requireApproval) {
    rules.push("- Report back before spawning workers and wait for user approval");
  }

  const rulesBlock = rules.length > 0 ? `\n\nRules:\n${rules.join("\n")}` : "";

  const delegationMandate = `CRITICAL: You are the ORCHESTRATOR for "${team.name}". Your role is to PLAN and COORDINATE — never to implement.

YOUR WORKFLOW:
1. PLAN: Analyze the task. Break it into specific subtasks for your workers.
2. ARTIFACTS: Check if planning artifacts exist (zana_artifact_list / zana_artifact_read) — use them for context.
3. TICKETS: Create a ticket (zana_ticket_create) for each subtask with clear acceptance criteria.
4. SPRINT: Optionally create and start a sprint to group tickets.
5. SPAWN: For each subtask, spawn the appropriate worker from your roster using zana_spawn_agent.
   - Give each worker a DETAILED prompt: what to build, which files to create, what conventions to follow.
   - Include context from earlier workers' output when tasks are sequential.
   - Spawn independent tasks in parallel for speed.
6. MONITOR: Poll zana_agent_status until workers complete. Use Read to verify output files exist.
7. COLLECT: Call zana_agent_result to get each worker's output summary.
8. VALIDATE: Check that deliverables match requirements. If a worker failed, spawn a replacement.
9. CLOSE: Mark tickets done via zana_ticket_complete with a result summary.

RULES:
- You MUST NOT write code, create files, or edit files. You have NO implementation tools.
- You MUST spawn workers for ALL implementation tasks — no exceptions.
- You MAY use Read to inspect workspace state and verify worker output.
- If a worker produces incomplete output, spawn another to finish — do NOT do it yourself.
- Give workers FULL context: describe the file structure, naming conventions, dependencies on other workers' output.

`;

  if (team.dynamicSpawning) {
    const allProfiles = _profileStore().listProfiles();
    const profileCatalog = allProfiles
      .filter(p => !p.id.includes("orchestrator") && !p.id.includes("swarm-orchestrator"))
      .map(p => `- ${p.icon || "◆"} **${p.displayName}** (id: \`${p.id}\`): ${p.description || "No description"}`)
      .join("\n");

    const dynamicRules = [
      `- Max total workers: ${team.maxTotalWorkers || 10}`,
      `- Max concurrent workers: ${team.rules?.maxConcurrentWorkers || 5}`,
    ];
    if (team.rules?.requireApproval) {
      dynamicRules.push("- Report back before spawning workers and wait for user approval");
    }

    const artifactNote = `\nPlanning artifacts may be available. Call zana_artifact_list and zana_artifact_read to access shared architecture docs and requirement specs BEFORE spawning workers.\n`;

    return `${delegationMandate}You are the ORCHESTRATOR for "${team.name}" with DYNAMIC TEAM COMPOSITION.\n\n` +
      `Analyze the task and spawn the exact workers you need from ALL available profiles.\n` +
      `You decide how many of each type based on complexity.\n${artifactNote}\n` +
      `Available Profiles:\n${profileCatalog}\n\n` +
      `Constraints:\n${dynamicRules.join("\n")}\n\n` +
      `Task:\n${userPrompt || team.initialPrompt || "Awaiting instructions."}`;
  }

  const artifactNote = `\nPlanning artifacts may be available. Call zana_artifact_list and zana_artifact_read to access shared architecture docs and requirement specs BEFORE spawning workers.\n`;

  return `${delegationMandate}You are leading team "${team.name}" (${totalSlots} total slots). Your available workers:\n\n${workerList}${rulesBlock}${artifactNote}\n\nTask:\n${userPrompt || team.initialPrompt || "Awaiting instructions."}`;
}

export function startTeam(teamId, options = {}) {
  const team = teamStore.getTeam(teamId);
  if (!team) return { ok: false, error: "team not found" };

  if (runningTeams.has(teamId)) {
    return { ok: false, error: "team already running" };
  }

  const orchestratorProfile = _profileStore().getProfile(team.orchestratorProfileId);
  if (!orchestratorProfile) {
    return { ok: false, error: `orchestrator profile not found: ${team.orchestratorProfileId}` };
  }

  const slots = team.slots || team.workerProfileIds.map((id) => ({ profileId: id, quantity: 1 }));
  const workerProfiles = [...new Set(slots.map((s) => s.profileId))]
    .map((id) => _profileStore().getProfile(id))
    .filter(Boolean);

  const prompt = buildOrchestratorPrompt(team, workerProfiles, options.prompt);

  const augmentedProfile = {
    ...orchestratorProfile,
    appendSystemPrompt: [
      orchestratorProfile.appendSystemPrompt || "",
      `\n\n--- TEAM CONTEXT ---\n${prompt}`,
    ].join(""),
    disallowedTools: buildTeamLeadDisallowedTools(team, orchestratorProfile),
  };

  const cwd = options.cwd || process.env.HOME;
  const headless = options.headless || !!process.env.ZANA_HEADLESS;
  const kickoffMessage = options.prompt || team.initialPrompt || "Begin working on the task described in your instructions.";

  let result;
  if (headless) {
    result = _agentManager().spawnHeadlessAgent(augmentedProfile, { cwd, multiTurn: true });
    setTimeout(() => {
      _agentManager().writeToAgent(result.agentId, {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: kickoffMessage }] },
      });
    }, 2000);
  } else {
    result = _agentManager().spawnInteractive(augmentedProfile, { cwd, cols: options.cols, rows: options.rows });
    setTimeout(() => {
      const ptyHost = require("@zana/core").agents.ptyHost;
      ptyHost.writeTerminal(result.terminalId, kickoffMessage + "\n");
    }, 20000);
  }

  const checkpoint = checkpointResume.createFromTeam(teamId, team.name, result.agentId, cwd);

  runningTeams.set(teamId, {
    teamId,
    teamName: team.name,
    teamIcon: team.icon,
    orchestratorAgentId: result.agentId,
    checkpointId: checkpoint.id,
    checkpointedAgents: new Set(),
    status: "running",
    startedAt: Date.now(),
  });

  notifyChange();
  _bus().emit(_EVENTS().TEAM_STARTED, { teamId, teamName: team.name, orchestratorAgentId: result.agentId });

  return { ok: true, orchestratorAgentId: result.agentId, terminalId: result.terminalId };
}

export function stopTeam(teamId) {
  const running = runningTeams.get(teamId);
  if (!running) return { ok: false, error: "team not running" };

  // Snapshot pending workers into checkpoint before killing
  if (running.checkpointId) {
    const allAgents = _agentManager().listAgents();
    const activeWorkers = allAgents.filter(
      (a) => a.parentAgentId === running.orchestratorAgentId && a.state === "active"
    );
    for (const worker of activeWorkers) {
      checkpointStore.addPendingAgent(running.checkpointId, {
        agentId: worker.id,
        profileId: worker.profileId,
        prompt: worker.lastAction || "",
        parentAgentId: running.orchestratorAgentId,
        dependencies: [],
      });
    }
    checkpointStore.update(running.checkpointId, { status: "stopped" });
  }

  _agentManager().killAgent(running.orchestratorAgentId);

  const allAgents = _agentManager().listAgents();
  const children = allAgents.filter((a) => a.parentAgentId === running.orchestratorAgentId);
  for (const child of children) {
    _agentManager().killAgent(child.id);
  }

  running.status = "stopped";
  notifyChange();
  _bus().emit(_EVENTS().TEAM_STOPPED, { teamId, teamName: running.teamName, reason: "user" });

  setTimeout(() => {
    runningTeams.delete(teamId);
    notifyChange();
  }, 3000);

  return { ok: true };
}

export function getTeamStatus(teamId) {
  const running = runningTeams.get(teamId);
  if (!running) return null;

  const allAgents = _agentManager().listAgents();
  const orchestrator = allAgents.find((a) => a.id === running.orchestratorAgentId);
  const workers = allAgents.filter((a) => a.parentAgentId === running.orchestratorAgentId);

  if (orchestrator && orchestrator.state === "terminated" && running.status === "running") {
    running.status = "completed";
    notifyChange();
  }

  return {
    ...running,
    orchestrator: orchestrator || null,
    workers,
  };
}

export function listRunningTeams() {
  const allAgents = _agentManager().listAgents();
  return Array.from(runningTeams.values()).map((rt) => {
    const orchestrator = allAgents.find((a) => a.id === rt.orchestratorAgentId);
    const workers = allAgents.filter((a) => a.parentAgentId === rt.orchestratorAgentId);
    return { ...rt, orchestrator: orchestrator || null, workers };
  });
}

export function resumeTeam(checkpointId) {
  return checkpointResume.resume(checkpointId, _agentManager(), _profileStore());
}

export function listCheckpoints(filter) {
  return checkpointStore.list(filter);
}

export function getCheckpoint(checkpointId) {
  return checkpointStore.load(checkpointId);
}

