module.exports = {
  tickets: {
    service: require("./tickets/service"),
    store: require("./tickets/store"),
    db: require("./tickets/db"),
    migration: require("./tickets/migration"),
    watcher: require("./tickets/watcher"),
    sweeper: require("./tickets/sweeper"),
  },
  scheduling: {
    service: require("./scheduling/service"),
    store: require("./scheduling/store"),
    workflowEngine: require("./scheduling/workflow-engine"),
    schema: require("./scheduling/schema"),
  },
  teams: {
    manager: require("./teams/manager"),
    store: require("./teams/store"),
  },
  runs: {
    store: require("./runs/store"),
    tracker: require("./runs/tracker"),
    artifacts: require("./runs/artifact-store"),
    plans: require("./runs/plans-store"),
    checkpoint: {
      store: require("./runs/checkpoint/store"),
      resume: require("./runs/checkpoint/resume"),
    },
  },
  deliberation: require("./deliberation"),
  // Re-exported from @zana-ai/core so callers downstream of @zana-ai/work can
  // `instanceof`-check the tenant-isolation gate without taking a direct
  // dependency on @zana-ai/core.
  get WorkspaceNotInitializedError() {
    return require("@zana-ai/core").project.workspaceContext.WorkspaceNotInitializedError;
  },
};
