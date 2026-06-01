// Deliberation module — exposes the runtime config to the deliberation/* code.
// The actual deliberation logic lives in @zana-ai/work; this module is a thin
// config-host so users can `zana_module_config_set("deliberation", key, value)`
// and have the change ripple to both bridges:
//   - @zana-ai/work/src/deliberation/runtime-config.ts (rounds, quorum, mode, TTL,
//     OCC retries, synthesis threshold)
//   - @zana-ai/core/src/agents/probe-config.ts (probeTimeoutMs, probeRawMaxBytes)
//
// Two bridges are used (not one) to avoid a require cycle: probeAgent lives in
// @zana-ai/core and must not depend on @zana-ai/work, which already depends on core.

let configRef = {};
let logFn = (msg) => process.stderr.write(`[deliberation] ${msg}\n`);

function _publish(cfg) {
  // @zana-ai/work bridge — drives propose() defaults, TTL, OCC retries, synthesis threshold.
  try {
    const work = require("@zana-ai/work");
    if (work.deliberation && typeof work.deliberation.setRuntimeConfig === "function") {
      work.deliberation.setRuntimeConfig(cfg);
    }
  } catch (err) {
    logFn(`failed to publish to @zana-ai/work runtime-config: ${err && err.message}`);
  }

  // @zana-ai/core probe-config bridge — drives probeAgent timeout + raw-byte cap.
  try {
    const core = require("@zana-ai/core");
    const probeCfg = core && core.agents && core.agents.probeConfig;
    if (probeCfg && typeof probeCfg.setProbeConfig === "function") {
      probeCfg.setProbeConfig({
        probeTimeoutMs: cfg.probeTimeoutMs,
        probeRawMaxBytes: cfg.probeRawMaxBytes,
        probeCacheTtlMs: cfg.probeCacheTtlMs,
      });
    }
  } catch (err) {
    logFn(`failed to publish to @zana-ai/core probe-config: ${err && err.message}`);
  }
}

module.exports = {
  async init(ctx) {
    logFn = (msg) => ctx.logger.info(msg);
    configRef = ctx.config || {};
    _publish(configRef);

    // FU-config-5 — workspace-scope-config / global-scope-checkpoint mismatch.
    // If the deliberation module loads but the workspace context is not
    // initialized, the runtime config is project-scoped while the checkpoint
    // store + CAS would silently fall back to ~/.zana/* (cross-tenant view).
    // FU-T2d/T4c now refuse those writes hard, but the operator deserves a
    // warn at module-load time so the failure mode is signposted before the
    // first propose() call rather than buried inside a stack trace.
    try {
      const core = require("@zana-ai/core");
      const wc = core && core.project && core.project.workspaceContext;
      if (wc && typeof wc.isInitialized === "function" && !wc.isInitialized()) {
        ctx.logger.warn(
          "deliberation module loaded against uninitialized workspace; " +
            "deliberation writes will be refused (run `zana init` to enable).",
        );
      }
    } catch (err) {
      // Non-fatal — module still loads; the gate at write time will surface
      // any real error. Best-effort warn only.
      ctx.logger.debug(`deliberation init: workspace probe failed: ${err && err.message}`);
    }

    ctx.logger.info("deliberation module ready");
    return {}; // no api surface — config is the surface
  },

  // Re-publish on config changes — the loader calls onConfigChanged when the
  // module's config block changes on disk.
  onConfigChanged(newCfg) {
    configRef = newCfg || {};
    _publish(configRef);
    logFn("deliberation config updated");
  },

  async shutdown() {
    logFn("deliberation shutting down");
  },
};
