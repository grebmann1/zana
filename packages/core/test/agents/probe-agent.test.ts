import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as manager from "@zana/core/src/agents/manager.ts";
import * as probeConfig from "@zana/core/src/agents/probe-config.ts";
import { bus, EVENTS } from "@zana/core/src/events/bus.ts";
import type { AgentProbedPayload } from "@zana/core/src/events/deliberation-events.ts";

/**
 * These tests inject fake `spawnHeadlessAgent` / `getAgent` / `killAgent`
 * implementations via the third `deps` argument of `probeAgent`. No vi.spyOn,
 * no module.exports indirection — the production code path is exactly what
 * runs at runtime, just with deps swapped at the call site.
 */

type FakeAgent = {
  id: string;
  state: string;
  result: string | null;
  outputBuffer: string | null;
  model: string;
  childProcess?: any;
};

function makeProfile(overrides: any = {}) {
  return {
    id: "test-profile",
    displayName: "Test Profile",
    model: "claude-sonnet-4-7",
    allowedTools: ["Read", "Write", "Bash"],
    ...overrides,
  };
}

/**
 * Build a `deps` bundle backed by an in-memory agents Map.
 * `responder(prompt)` returns either:
 *   - { result: string, delayMs?: number, outputBuffer?: string, model?: string }
 *       → terminate after delayMs (default 5ms) with that result
 *   - { neverResolve: true } → leave agent in "active" forever (timeout case)
 */
function makeFakeDeps(
  responder: (prompt: string) => {
    result?: string;
    outputBuffer?: string;
    delayMs?: number;
    neverResolve?: boolean;
    model?: string;
  },
) {
  const records = new Map<string, FakeAgent>();
  const spawnCalls: Array<{ profile: any; options: any }> = [];
  const killCalls: string[] = [];
  let counter = 0;

  const spawnHeadlessAgent = vi.fn((profile: any, options: any) => {
    counter += 1;
    const id = `fake-agent-${counter}`;
    spawnCalls.push({ profile, options });
    const decision = responder(options?.prompt || "");
    const rec: FakeAgent = {
      id,
      state: "active",
      result: null,
      outputBuffer: null,
      model: decision.model || profile?.model || "default",
      childProcess: { kill: vi.fn() },
    };
    records.set(id, rec);

    if (!decision.neverResolve) {
      const delay = decision.delayMs ?? 5;
      setTimeout(() => {
        rec.result = decision.result ?? "";
        rec.outputBuffer = decision.outputBuffer ?? null;
        rec.state = "terminated";
      }, delay);
    }
    return { agentId: id, terminalId: `term-${id}` };
  });

  const getAgent = vi.fn((id: string) => records.get(id) || null);

  const killAgent = vi.fn((id: string) => {
    killCalls.push(id);
    records.delete(id);
    return true;
  });

  return {
    deps: { spawnHeadlessAgent, getAgent, killAgent } as any,
    records,
    spawnCalls,
    killCalls,
    spawnHeadlessAgent,
    getAgent,
    killAgent,
  };
}

describe("probeAgent", () => {
  it("returns ok:true when all three legs pass", async () => {
    const { deps } = makeFakeDeps((prompt) => {
      if (prompt.includes("42")) return { result: "The answer is 42." };
      if (prompt.includes("PROBE_OK")) return { result: "stdout: PROBE_OK" };
      return { result: "PROBE_REFUSAL_OK" };
    });

    const profile = makeProfile();
    const out = await manager.probeAgent(profile, undefined, deps);

    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.latencyMs).toBeLessThan(5000);
    expect(out.modelId).toBe("claude-sonnet-4-7");
    expect(out.probeId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.legs).toHaveLength(3);
  });

  it("returns ok:false with a 'factual' failure when the factual leg returns wrong content", async () => {
    const { deps } = makeFakeDeps((prompt) => {
      if (prompt.includes("42")) return { result: "I don't know." };
      if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
      return { result: "PROBE_REFUSAL_OK" };
    });

    const out = await manager.probeAgent(makeProfile(), undefined, deps);

    expect(out.ok).toBe(false);
    expect(out.failures.some((f) => f.leg === "factual")).toBe(true);
    expect(out.failures.some((f) => f.kind === "validation" && f.reason.includes("42"))).toBe(true);
  });

  it("skips the toolUse leg when the profile cannot use Bash and still passes", async () => {
    const { deps, spawnHeadlessAgent } = makeFakeDeps((prompt) => {
      if (prompt.includes("42")) return { result: "42" };
      return { result: "PROBE_REFUSAL_OK" };
    });

    const profile = makeProfile({ allowedTools: ["Read", "Write"] });
    const out = await manager.probeAgent(profile, undefined, deps);

    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    // factual + instructionFollowing only — no toolUse spawn.
    expect(spawnHeadlessAgent).toHaveBeenCalledTimes(2);
    const prompts = spawnHeadlessAgent.mock.calls.map((c: any[]) => c[1]?.prompt as string);
    expect(prompts.every((p) => !p.includes("PROBE_OK"))).toBe(true);
  });

  it("returns ok:false with a timeout failure and calls killAgent for cleanup", async () => {
    const { deps, killAgent } = makeFakeDeps((prompt) => {
      if (prompt.includes("42")) return { neverResolve: true };
      if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
      return { result: "PROBE_REFUSAL_OK" };
    });

    const out = await manager.probeAgent(makeProfile(), { timeoutMs: 100 }, deps);

    expect(out.ok).toBe(false);
    expect(out.failures.some((f) => f.kind === "timeout")).toBe(true);
    expect(out.failures.some((f) => f.leg === "factual" && f.kind === "timeout")).toBe(true);
    // Timeout leg MUST clean up via killAgent (not bare child.kill).
    expect(killAgent).toHaveBeenCalledTimes(1);
  });

  it("assigns a unique probeId on every call", async () => {
    const { deps } = makeFakeDeps(() => ({ result: "42 PROBE_OK PROBE_REFUSAL_OK" }));

    const a = await manager.probeAgent(makeProfile(), undefined, deps);
    const b = await manager.probeAgent(makeProfile(), undefined, deps);
    const c = await manager.probeAgent(makeProfile(), undefined, deps);

    const ids = new Set([a.probeId, b.probeId, c.probeId]);
    expect(ids.size).toBe(3);
  });

  it("instructionFollowing leg fails when the required token is absent", async () => {
    const { deps } = makeFakeDeps((prompt) => {
      if (prompt.includes("42")) return { result: "42" };
      if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
      // Non-empty, polite-looking response — the OLD tautology check would have
      // PASSED this. The new instruction-following check must FAIL it.
      return { result: "Sure, I understand the instruction completely." };
    });

    const out = await manager.probeAgent(makeProfile(), undefined, deps);

    expect(out.ok).toBe(false);
    expect(out.failures.some((f) => f.leg === "instructionFollowing")).toBe(true);
    expect(out.failures.some((f) => f.kind === "validation" && f.reason.includes("PROBE_REFUSAL_OK"))).toBe(true);
  });

  it("returns ok:false with explicit failure when the profile has no declared model", async () => {
    const { deps, spawnHeadlessAgent } = makeFakeDeps(() => ({ result: "42 PROBE_OK PROBE_REFUSAL_OK" }));

    const profile = makeProfile({ model: undefined });
    const out = await manager.probeAgent(profile, undefined, deps);

    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toEqual({
      leg: null,
      kind: "misconfig",
      reason: "profile has no declared model",
    });
    expect(out.modelId).toBe("unknown");
    expect(out.legs).toEqual([]);
    // Must NOT spawn any agents for a misconfigured profile.
    expect(spawnHeadlessAgent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // FU-T3b — agent:probed event emission
  // FU-T3a — typed failure kind categorization
  // ---------------------------------------------------------------------
  describe("agent:probed event (FU-T3b)", () => {
    let captured: AgentProbedPayload[];
    let listener: (p: AgentProbedPayload) => void;

    beforeEach(() => {
      captured = [];
      listener = (p) => { captured.push(p); };
      bus.on(EVENTS.AGENT_PROBED, listener);
    });

    afterEach(() => {
      bus.off(EVENTS.AGENT_PROBED, listener);
    });

    it("fires exactly once with typed payload on every probe", async () => {
      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { result: "42" };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });

      const profile = makeProfile();
      const out = await manager.probeAgent(profile, undefined, deps);

      expect(captured).toHaveLength(1);
      const ev = captured[0];
      expect(ev.probeId).toBe(out.probeId);
      expect(ev.profileId).toBe(profile.id);
      expect(ev.modelId).toBe("claude-sonnet-4-7");
      expect(ev.ok).toBe(true);
      expect(ev.failures).toEqual([]);
      expect(ev.latencyMs).toBe(out.latencyMs);
      expect(typeof ev.ts).toBe("string");
      expect(new Date(ev.ts).toString()).not.toBe("Invalid Date");
    });

    it("fires once even on the misconfig (no-model) short-circuit path", async () => {
      const { deps } = makeFakeDeps(() => ({ result: "irrelevant" }));
      const profile = makeProfile({ model: undefined });
      const out = await manager.probeAgent(profile, undefined, deps);

      expect(captured).toHaveLength(1);
      expect(captured[0].ok).toBe(false);
      expect(captured[0].probeId).toBe(out.probeId);
      expect(captured[0].failures[0].kind).toBe("misconfig");
    });
  });

  describe("failure kinds are correctly categorized (FU-T3a)", () => {
    it("timeout → kind:'timeout'", async () => {
      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { neverResolve: true };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });
      const out = await manager.probeAgent(makeProfile(), { timeoutMs: 80 }, deps);
      const factualFailure = out.failures.find((f) => f.leg === "factual");
      expect(factualFailure).toBeDefined();
      expect(factualFailure!.kind).toBe("timeout");
      expect(factualFailure!.reason).toContain("timed out");
    });

    it("missing model → kind:'misconfig'", async () => {
      const { deps } = makeFakeDeps(() => ({ result: "stub" }));
      const out = await manager.probeAgent(makeProfile({ model: null }), undefined, deps);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0].kind).toBe("misconfig");
      expect(out.failures[0].leg).toBeNull();
    });

    it("wrong content → kind:'validation' with raw output", async () => {
      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { result: "definitely not the answer" };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });
      const out = await manager.probeAgent(makeProfile(), undefined, deps);
      const factualFailure = out.failures.find((f) => f.leg === "factual");
      expect(factualFailure).toBeDefined();
      expect(factualFailure!.kind).toBe("validation");
      expect(factualFailure!.raw).toBe("definitely not the answer");
    });
  });

  // ---------------------------------------------------------------------
  // FU-config — probe-config bridge wires probeAgent defaults from
  // module-managed runtime config (driven by core/modules/deliberation).
  // ---------------------------------------------------------------------
  describe("probeAgent honors probe-config bridge (FU-config)", () => {
    afterEach(() => {
      probeConfig.resetProbeConfig();
    });

    it("uses probe-config.probeTimeoutMs when caller omits probe.timeoutMs", async () => {
      // Set a tiny configured timeout; the factual leg never resolves so
      // the configured timeout is what trips the failure.
      probeConfig.setProbeConfig({ probeTimeoutMs: 60 });

      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { neverResolve: true };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });

      const out = await manager.probeAgent(makeProfile(), undefined, deps);
      const factualFailure = out.failures.find((f) => f.leg === "factual");
      expect(factualFailure).toBeDefined();
      expect(factualFailure!.kind).toBe("timeout");
      // Timeout reason carries the configured timeoutMs verbatim.
      expect(factualFailure!.reason).toContain("60ms");
    });

    it("explicit probe.timeoutMs overrides probe-config default", async () => {
      // Configured timeout would be 60ms; caller passes 200ms — caller wins.
      probeConfig.setProbeConfig({ probeTimeoutMs: 60 });

      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { neverResolve: true };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });

      const out = await manager.probeAgent(makeProfile(), { timeoutMs: 200 }, deps);
      const factualFailure = out.failures.find((f) => f.leg === "factual");
      expect(factualFailure).toBeDefined();
      expect(factualFailure!.reason).toContain("200ms");
    });

    it("resetProbeConfig restores the 30000ms default", () => {
      probeConfig.setProbeConfig({ probeTimeoutMs: 12345 });
      expect(probeConfig.getProbeConfig().probeTimeoutMs).toBe(12345);
      probeConfig.resetProbeConfig();
      expect(probeConfig.getProbeConfig().probeTimeoutMs).toBe(30000);
      expect(probeConfig.getProbeConfig().probeRawMaxBytes).toBe(1024);
    });

    it("probeRawMaxBytes truncates ProbeFailure.raw on validation failure", async () => {
      probeConfig.setProbeConfig({ probeTimeoutMs: 30000, probeRawMaxBytes: 8 });

      const longString = "definitely not the answer at all";
      const { deps } = makeFakeDeps((prompt) => {
        if (prompt.includes("42")) return { result: longString };
        if (prompt.includes("PROBE_OK")) return { result: "PROBE_OK" };
        return { result: "PROBE_REFUSAL_OK" };
      });

      const out = await manager.probeAgent(makeProfile(), undefined, deps);
      const factualFailure = out.failures.find((f) => f.leg === "factual");
      expect(factualFailure).toBeDefined();
      expect(factualFailure!.raw).toBe(longString.slice(0, 8));
    });
  });
});
