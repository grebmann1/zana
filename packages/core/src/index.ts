module.exports = {
  init: require("./core").init,
  config: require("./config"),

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
  teams: {
    manager: require("./teams/manager"),
    store: require("./teams/store"),
  },
  events: {
    bus: require("./events/bus"),
    service: require("./events/service"),
    store: require("./events/store"),
    log: require("./events/log"),
    stats: require("./events/stats-engine"),
  },
  tickets: {
    service: require("./tickets/service"),
    store: require("./tickets/store"),
    db: require("./tickets/db"),
    migration: require("./tickets/migration"),
    watcher: require("./tickets/watcher"),
  },
  runs: {
    store: require("./runs/store"),
    tracker: require("./runs/tracker"),
    artifacts: require("./runs/artifact-store"),
    plans: require("./runs/plans-store"),
    checkpoint: require("./runs/checkpoint/store"),
  },
  scheduling: {
    service: require("./scheduling/service"),
    store: require("./scheduling/store"),
    workflow: require("./scheduling/workflow-engine"),
  },
  intelligence: {
    taskRouter: require("./intelligence/task-router"),
    goap: require("./intelligence/goap-planner"),
    vectorMemory: require("./intelligence/vector-memory"),
    backgroundWorkers: require("./intelligence/background-workers"),
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
  swarm: {
    events: require("./swarm/events"),
    router: require("./swarm/router"),
    spawner: require("./swarm/spawner"),
  },
  modules: {
    config: require("./modules/config"),
    loader: require("./modules/loader"),
    toolRegistry: require("./modules/tool-registry"),
    bridge: require("./modules/bridge"),
  },
  plugins: {
    loader: require("./plugins/loader"),
    scaffold: require("./plugins/scaffold"),
  },
  settings: {
    store: require("./settings/store"),
    skillStore: require("./settings/skill-store"),
  },

  persistence: require("./persistence"),
  guardrails: require("./guardrails/index"),
};
