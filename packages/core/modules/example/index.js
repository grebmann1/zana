// Example Zana module — demonstrates the module lifecycle.
//
// The module loader calls these hooks in order:
//   init(ctx)             — wire up subscriptions, return a public API object
//   recover(state, ctx)   — invoked instead of/before init when the daemon restarts
//   suspend()             — pause work (called before shutdown on graceful stop)
//   shutdown()            — release resources
//
// NOTE: only `init` and `recover` receive `ctx` from the module loader.
// `suspend` and `shutdown` are called without ctx, so they cannot use
// ctx.logger / ctx.bus — log directly to stderr via console.error instead.
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

  async suspend() {
    // ctx is not provided by the loader for suspend/shutdown; write to
    // stderr directly so the lifecycle is still observable.
    console.error("[example] suspending");
  },

  async shutdown() {
    console.error("[example] shutting down");
  },
};
