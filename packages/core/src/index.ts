module.exports = {
  init: require("./core").init,
  config: require("./config"),

  get swarm() {
    return require("@zana-ai/swarm");
  },
  get settings() {
    return require("@zana-ai/extras").settings;
  },
  get plugins() {
    return require("@zana-ai/extras").plugins;
  },
  get intelligence() {
    const i = require("@zana-ai/intelligence");
    return {
      taskRouter: i.taskRouter,
      goap: i.goapPlanner,
      vectorMemory: i.vectorMemory,
      backgroundWorkers: i.backgroundWorkers,
    };
  },
  get tickets() { return require("@zana-ai/work").tickets; },
  get scheduling() {
    const s = require("@zana-ai/work").scheduling;
    return { service: s.service, store: s.store, workflow: s.workflowEngine };
  },
  get teams() { return require("@zana-ai/work").teams; },
  get runs() {
    const r = require("@zana-ai/work").runs;
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
  // Re-exported at top level so callers can do
  //   const { WorkspaceNotInitializedError } = require("@zana-ai/core");
  // without reaching into project.* internals. Same class identity as
  // require("@zana-ai/core").project.workspaceContext.WorkspaceNotInitializedError
  // — both resolve to the singleton module.
  get WorkspaceNotInitializedError() {
    return require("./project/workspace-context").WorkspaceNotInitializedError;
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
    probeConfig: require("./agents/probe-config"),
  },
  events: {
    // Flat shape on purpose: bus IS the EventEmitter, EVENTS IS the constants.
    // Don't access .bus.bus — that's the wrong (legacy) shape.
    bus: require("./events/bus").bus,
    EVENTS: require("./events/bus").EVENTS,
    service: require("./events/service"),
    store: require("./events/store"),
    log: require("./events/log"),
    stats: require("./events/stats-engine"),
    // Type-only module — required so the resolved path is part of the package
    // surface; downstream TS consumers import payload types from
    // "@zana-ai/core/src/events/deliberation-events".
    deliberationEvents: require("./events/deliberation-events"),
  },
  get hooks() {
    const h = require("@zana-ai/server").hooks;
    return { server: h.server, enforcer: h.enforcer, installer: h.installer };
  },
  get api() {
    const a = require("@zana-ai/server").api;
    return { server: a.server, auth: a.authMiddleware, sse: a.sseBroadcaster, health: a.healthMonitor };
  },
  modules: {
    config: require("./modules/config"),
    loader: require("./modules/loader"),
    toolRegistry: require("./modules/tool-registry"),
    bridge: require("./modules/bridge"),
  },
  persistence: require("./persistence"),
  guardrails: require("./guardrails/index"),
  util: {
    logger: require("./util/logger"),
  },
};
