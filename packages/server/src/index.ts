module.exports = {
  hooks: {
    server: require("./hooks/server"),
    enforcer: require("./hooks/enforcer"),
    enforcerCli: require("./hooks/enforcer-cli"),
    installer: require("./hooks/installer"),
  },
  api: {
    server: require("./api/server"),
    authMiddleware: require("./api/auth-middleware"),
    sseBroadcaster: require("./api/sse-broadcaster"),
    healthMonitor: require("./api/health-monitor"),
    // orchestrator-mcp is a CLI shim — not loaded by default to avoid runtime side effects
  },
};
