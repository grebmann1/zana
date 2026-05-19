module.exports = {
  tickets: {
    service: require("./tickets/service"),
    store: require("./tickets/store"),
    db: require("./tickets/db"),
    migration: require("./tickets/migration"),
    watcher: require("./tickets/watcher"),
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
};
