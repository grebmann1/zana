import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const EVENTS = {
  AGENT_SPAWNED: "agent:spawned",
  AGENT_TERMINATED: "agent:terminated",
  AGENT_HOOK: "agent:hook",
  AGENT_STATUS_CHANGED: "agent:statusChanged",
  TEAM_STARTED: "team:started",
  TEAM_STOPPED: "team:stopped",
  TEAM_WORKER_SPAWNED: "team:workerSpawned",
  HIVE_READY: "hive:ready",
  HIVE_SHUTDOWN: "hive:shutdown",
  PLUGIN_LOADED: "plugin:loaded",
  SETTINGS_CHANGED: "settings:changed",
  PROFILE_SAVED: "profile:saved",
  PROFILE_DELETED: "profile:deleted",
  RUN_STARTED: "run:started",
  RUN_ENDED: "run:ended",
  FILE_PRODUCED: "file:produced",
};

