import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const EVENTS = {
  AGENT_SPAWNED: "agent:spawned",
  AGENT_TERMINATED: "agent:terminated",
  AGENT_HOOK: "agent:hook",
  AGENT_STATUS_CHANGED: "agent:statusChanged",
  AGENT_PROBED: "agent:probed",
  AGENT_ANOMALY: "agent:anomaly",
  TEAM_STARTED: "team:started",
  TEAM_STOPPED: "team:stopped",
  TEAM_WORKER_SPAWNED: "team:workerSpawned",
  ZANA_READY: "zana:ready",
  ZANA_SHUTDOWN: "zana:shutdown",
  PLUGIN_LOADED: "plugin:loaded",
  SETTINGS_CHANGED: "settings:changed",
  PROFILE_SAVED: "profile:saved",
  PROFILE_DELETED: "profile:deleted",
  RUN_STARTED: "run:started",
  RUN_ENDED: "run:ended",
  FILE_PRODUCED: "file:produced",
  DELIBERATION_PROPOSED: "deliberation:proposed",
  DELIBERATION_VOTE: "deliberation:vote",
  DELIBERATION_SYNTHESIS: "deliberation:synthesis",
  DELIBERATION_CONVERGED: "deliberation:converged",
  DELIBERATION_ESCALATED: "deliberation:escalated",
  DELIBERATION_OVERRIDE: "deliberation:override",
  DELIBERATION_DEGRADED: "deliberation:degraded",
  DELIBERATION_GENERALIST_ADDED: "deliberation:generalistAdded",
  DELIBERATION_HUMAN_NUDGE: "deliberation:humanNudge",
};

