module.exports = {
  init: require("./core").init,
  config: require("./config"),

  get swarm() {
    return require("@zana/swarm");
  },
  get settings() {
    return require("@zana/extras").settings;
  },
  get plugins() {
    return require("@zana/extras").plugins;
  },
  get intelligence() {
    const i = require("@zana/intelligence");
    return {
      taskRouter: i.taskRouter,
      goap: i.goapPlanner,
      vectorMemory: i.vectorMemory,
      backgroundWorkers: i.backgroundWorkers,
    };
  },
  get tickets() { return require("@zana/work").tickets; },
  get scheduling() {
    const s = require("@zana/work").scheduling;
    return { service: s.service, store: s.store, workflow: s.workflowEngine };
  },
  get teams() { return require("@zana/work").teams; },
  get runs() {
    const r = require("@zana/work").runs;
    return {
      store: r.store,
      tracker: r.tracker,
      artifacts: r.artifacts,
      plans: r.plans,
      checkpoint: r.checkpoint.store,
    };
  },

  project: {
    init: require("./project/init"),
    migrate: require("./project/migrate"),
    registry: require("./project/registry"),
    watcher: require("./project/watcher"),
    workspaceContext: require("./project/workspace-context"),
  },
  daemon: {
    registry: require("./daemon/registry"),
    serviceManager: require("./daemon/service-manager"),
    connectionRegistry: require("./daemon/connection-registry"),
  },
  agents: {
    manager: require("./agents/manager"),
    spawner: require("./agents/spawner"),
    profileStore: require("./agents/profile-store"),
    ptyHost: require("./agents/pty-host"),
    modelRouter: require("./agents/model-router"),
    terminalRelay: require("./agents/terminal-relay"),
  },
  events: {
    bus: require("./events/bus"),
    service: require("./events/service"),
    store: require("./events/store"),
    log: require("./events/log"),
    stats: require("./events/stats-engine"),
  },
  hooks: {
    server: require("./hooks/server"),
    enforcer: require("./hooks/enforcer"),
    installer: require("./hooks/installer"),
  },
  api: {
    server: require("./api/server"),
    auth: require("./api/auth-middleware"),
    sse: require("./api/sse-broadcaster"),
    health: require("./api/health-monitor"),
  },
  modules: {
    config: require("./modules/config"),
    loader: require("./modules/loader"),
    toolRegistry: require("./modules/tool-registry"),
    bridge: require("./modules/bridge"),
  },
  persistence: require("./persistence"),
  guardrails: require("./guardrails/index"),
};
