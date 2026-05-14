// Example Zana module — demonstrates the module lifecycle.
//
// The module loader calls these hooks in order:
//   init      — wire up subscriptions, return a public API object
//   recover   — invoked instead of/before init when the daemon restarts
//   suspend   — pause work (called before shutdown on graceful stop)
//   shutdown  — release resources
//
// Anything returned from init() becomes the module's public API and can be
// retrieved by other modules via ctx.getModule("example").
module.exports = {
  async init(ctx) {
    const greeting = ctx.config?.greeting || "hello";
    ctx.logger.info(`example module ready (${greeting})`);
    ctx.bus.emit("example:initialized", { ts: Date.now(), greeting });
    return {
      // Public API — accessible via core.moduleLoader.getModule("example").api
      ping: () => "pong",
      greeting: () => greeting,
    };
  },

  async recover(_state, ctx) {
    ctx.logger.info("example module recovered");
  },

  async suspend(ctx) {
    ctx.logger.info("example module suspending");
  },

  async shutdown(ctx) {
    ctx.logger.info("example module shutting down");
  },
};
