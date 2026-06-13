// Resilience module — a tiny in-memory circuit breaker keyed by operation name.
//
// Wires the isOpen / recordFailure / recordSuccess seams that the agent spawn
// path already calls (packages/core/src/agents/{dispatch,lifecycle}.ts). Before
// this module existed those calls resolved to undefined → the breaker was a
// permanent no-op. See ADR docs/decisions and
// reviews/claude-unleashed-incorporation.md §2b.
//
// Per-key state machine:
//   closed   — normal; failures accumulate.
//   open      — after `failureThreshold` consecutive failures; isOpen() returns
//               true and callers should skip the operation. Stays open for
//               `cooldownMs`.
//   half-open — after the cooldown elapses, isOpen() returns false ONCE to let a
//               single probe through. A recordSuccess closes the breaker; a
//               recordFailure re-opens it (resetting the cooldown).
//
// Distinct from the spawn-overload streak escalation in lifecycle.ts: that
// throttles deliberate load *refusals*; this breaks on spawn *failures*
// (auth/quota/transport) so a melted backend doesn't get hammered.

const DEFAULTS = { failureThreshold: 5, cooldownMs: 30_000 };

module.exports = {
  async init(ctx) {
    const cfg = {
      failureThreshold: ctx.config?.failureThreshold ?? DEFAULTS.failureThreshold,
      cooldownMs: ctx.config?.cooldownMs ?? DEFAULTS.cooldownMs,
    };
    const bus = ctx.bus;
    const log = ctx.logger;

    // key -> { failures, openedAt|null, probing }
    const breakers = new Map();
    const get = (key) => {
      let b = breakers.get(key);
      if (!b) { b = { failures: 0, openedAt: null, probing: false }; breakers.set(key, b); }
      return b;
    };

    function isOpen(key) {
      const b = get(key);
      if (b.openedAt == null) return false; // closed
      const elapsed = Date.now() - b.openedAt;
      if (elapsed >= cfg.cooldownMs) {
        // Cooldown elapsed → half-open: allow exactly one probe through.
        b.probing = true;
        return false;
      }
      return true; // still open
    }

    function recordFailure(key) {
      const b = get(key);
      b.failures += 1;
      b.probing = false;
      if (b.openedAt == null && b.failures >= cfg.failureThreshold) {
        b.openedAt = Date.now();
        log.warn(`circuit '${key}' OPEN after ${b.failures} consecutive failures`);
        bus?.emit?.("resilience:opened", { key, failures: b.failures });
      } else if (b.openedAt != null) {
        // Failed during/after the probe window → re-arm the cooldown.
        b.openedAt = Date.now();
      }
    }

    function recordSuccess(key) {
      const b = get(key);
      const wasOpen = b.openedAt != null;
      b.failures = 0;
      b.openedAt = null;
      b.probing = false;
      if (wasOpen) {
        log.info(`circuit '${key}' CLOSED after a successful probe`);
        bus?.emit?.("resilience:closed", { key });
      }
    }

    log.info(`resilience module ready (threshold=${cfg.failureThreshold}, cooldownMs=${cfg.cooldownMs})`);

    return {
      isOpen,
      recordFailure,
      recordSuccess,
      // Introspection for tests/diagnostics.
      _state: (key) => {
        const b = breakers.get(key);
        return b ? { ...b, open: b.openedAt != null } : null;
      },
    };
  },

  async recover(_state, ctx) {
    // Breaker state is in-memory and ephemeral — nothing to recover. Re-init.
    return module.exports.init(ctx);
  },
};
