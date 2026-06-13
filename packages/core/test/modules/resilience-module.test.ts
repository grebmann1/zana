// Tests for packages/core/modules/resilience/index.js
//
// The circuit breaker that backs the isOpen/recordFailure/recordSuccess seams
// in the agent spawn path. Covers: open after threshold, stay open during
// cooldown, half-open probe after cooldown, success closes, failed probe
// re-arms, per-key isolation. See reviews/claude-unleashed-incorporation.md §2b.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

const MODULE_PATH = path.resolve(__dirname, "../../modules/resilience/index.js");

function makeCtx(cfg: Record<string, unknown> = {}) {
  const emits: { event: string; payload: unknown }[] = [];
  return {
    ctx: {
      moduleId: "resilience",
      bus: { emit: (event: string, payload: unknown) => emits.push({ event, payload }), on: () => () => {}, query: () => [] },
      config: cfg,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
    emits,
  };
}

async function freshApi(cfg: Record<string, unknown> = {}) {
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  const { ctx, emits } = makeCtx(cfg);
  const api = await mod.init(ctx);
  return { api, emits };
}

describe("resilience module — circuit breaker", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); delete require.cache[require.resolve(MODULE_PATH)]; });

  it("init returns the breaker API and starts closed", async () => {
    const { api } = await freshApi();
    expect(typeof api.isOpen).toBe("function");
    expect(typeof api.recordFailure).toBe("function");
    expect(typeof api.recordSuccess).toBe("function");
    expect(api.isOpen("agent-spawn")).toBe(false);
  });

  it("opens after `failureThreshold` consecutive failures", async () => {
    const { api, emits } = await freshApi({ failureThreshold: 3, cooldownMs: 30_000 });
    api.recordFailure("agent-spawn");
    api.recordFailure("agent-spawn");
    expect(api.isOpen("agent-spawn")).toBe(false); // 2 < 3
    api.recordFailure("agent-spawn");
    expect(api.isOpen("agent-spawn")).toBe(true); // 3 → open
    expect(emits.some((e) => e.event === "resilience:opened")).toBe(true);
  });

  it("stays open during the cooldown, then half-opens to allow one probe", async () => {
    const { api } = await freshApi({ failureThreshold: 2, cooldownMs: 30_000 });
    api.recordFailure("k");
    api.recordFailure("k");
    expect(api.isOpen("k")).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(api.isOpen("k")).toBe(true); // still cooling down

    vi.advanceTimersByTime(20_001); // past cooldown
    expect(api.isOpen("k")).toBe(false); // half-open: probe allowed
  });

  it("a successful probe closes the breaker and emits closed", async () => {
    const { api, emits } = await freshApi({ failureThreshold: 2, cooldownMs: 1_000 });
    api.recordFailure("k");
    api.recordFailure("k");
    vi.advanceTimersByTime(1_001);
    expect(api.isOpen("k")).toBe(false); // half-open
    api.recordSuccess("k");
    expect(api._state("k").open).toBe(false);
    expect(api._state("k").failures).toBe(0);
    expect(emits.some((e) => e.event === "resilience:closed")).toBe(true);
  });

  it("a failed probe re-arms the cooldown (stays protective)", async () => {
    const { api } = await freshApi({ failureThreshold: 2, cooldownMs: 1_000 });
    api.recordFailure("k");
    api.recordFailure("k");
    vi.advanceTimersByTime(1_001);
    expect(api.isOpen("k")).toBe(false); // probe window
    api.recordFailure("k"); // probe failed
    expect(api.isOpen("k")).toBe(true); // re-open immediately
  });

  it("a success before opening resets the failure streak", async () => {
    const { api } = await freshApi({ failureThreshold: 3 });
    api.recordFailure("k");
    api.recordFailure("k");
    api.recordSuccess("k");
    api.recordFailure("k");
    expect(api.isOpen("k")).toBe(false); // streak reset → 1 < 3
  });

  it("breakers are isolated per key", async () => {
    const { api } = await freshApi({ failureThreshold: 2 });
    api.recordFailure("a");
    api.recordFailure("a");
    expect(api.isOpen("a")).toBe(true);
    expect(api.isOpen("b")).toBe(false);
  });
});
