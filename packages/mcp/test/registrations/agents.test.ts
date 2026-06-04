// Unit tests for registrations/agents.ts
//
// The tool definitions are exercised for correct schema shape.
// The non-trivial handler behaviours tested are:
//   - zana_spawn_agent threads callerAgentId → parentAgentId
//   - zana_spawn_agent_validated threads callerAgentId → parentAgentId
//     and defaults guardrails to [] when the caller omits the field
//   - All other handlers are thin callCore passthroughs — one smoke test each.
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { agents } from "../../src/registrations/agents.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (agents.handlers as Record<string, Handler>)[name];
}

interface Captured {
  op: string;
  args: Record<string, unknown>;
}

/** Returns a callCore spy that records every call and resolves with `result`. */
function makeCallCore(result: unknown = {}) {
  const calls: Captured[] = [];
  const callCore = (op: string, args: Record<string, unknown> = {}) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };
  return { callCore, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-definition shape
// ─────────────────────────────────────────────────────────────────────────────

describe("agents tool definitions", () => {
  const toolNames = agents.tools.map((t) => t.name);

  it("exposes the expected seven tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_spawn_agent",
        "zana_spawn_agent_validated",
        "zana_oneshot_query",
        "zana_list_agents",
        "zana_agent_status",
        "zana_agent_result",
        "zana_kill_agent",
      ]),
    );
    expect(toolNames).toHaveLength(7);
  });

  it("zana_spawn_agent requires profileId and prompt", () => {
    const tool = agents.tools.find((t) => t.name === "zana_spawn_agent")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["profileId", "prompt"]));
  });

  it("zana_spawn_agent_validated requires profileId, prompt, and guardrails", () => {
    const tool = agents.tools.find((t) => t.name === "zana_spawn_agent_validated")!;
    expect(tool.inputSchema.required).toEqual(
      expect.arrayContaining(["profileId", "prompt", "guardrails"]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_spawn_agent
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_spawn_agent handler", () => {
  const handler = getHandler("zana_spawn_agent");

  it("calls spawn_agent with profileId and prompt", async () => {
    const { callCore, calls } = makeCallCore({ agentId: "a1" });
    await handler({ profileId: "p1", prompt: "do work" }, { callCore, callerAgentId: null });
    expect(calls[0].op).toBe("spawn_agent");
    expect(calls[0].args).toMatchObject({ profileId: "p1", prompt: "do work" });
  });

  it("threads callerAgentId from context into parentAgentId", async () => {
    const { callCore, calls } = makeCallCore({ agentId: "child-1" });
    await handler(
      { profileId: "p2", prompt: "subtask" },
      { callCore, callerAgentId: "parent-agent-99" },
    );
    expect(calls[0].args.parentAgentId).toBe("parent-agent-99");
  });

  it("passes null parentAgentId when callerAgentId is not set", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler({ profileId: "p3", prompt: "top-level task" }, { callCore, callerAgentId: null });
    expect(calls[0].args.parentAgentId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_spawn_agent_validated
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_spawn_agent_validated handler", () => {
  const handler = getHandler("zana_spawn_agent_validated");

  it("defaults guardrails to [] when caller omits the field", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler(
      { profileId: "p1", prompt: "validate me" },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.guardrails).toEqual([]);
  });

  it("forwards provided guardrails unchanged", async () => {
    const guardrails = [{ type: "json-parse" }, { type: "no-secrets" }];
    const { callCore, calls } = makeCallCore({});
    await handler(
      { profileId: "p1", prompt: "go", guardrails },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.guardrails).toEqual(guardrails);
  });

  it("threads callerAgentId into parentAgentId", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler(
      { profileId: "p1", prompt: "go", guardrails: [] },
      { callCore, callerAgentId: "caller-7" },
    );
    expect(calls[0].args.parentAgentId).toBe("caller-7");
  });

  it("forwards optional maxRetries when supplied", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler(
      { profileId: "p1", prompt: "go", guardrails: [], maxRetries: 5 },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.maxRetries).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough handlers (smoke tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough handlers", () => {
  it("zana_oneshot_query calls spawn_oneshot with profileId, prompt, timeout", async () => {
    const { callCore, calls } = makeCallCore("answer");
    const handler = getHandler("zana_oneshot_query");
    await handler({ profileId: "p1", prompt: "q", timeout: 5000 }, { callCore });
    expect(calls[0].op).toBe("spawn_oneshot");
    expect(calls[0].args).toMatchObject({ profileId: "p1", prompt: "q", timeout: 5000 });
  });

  it("zana_list_agents calls list_agents", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_list_agents");
    await handler({}, { callCore });
    expect(calls[0].op).toBe("list_agents");
  });

  it("zana_agent_status calls agent_status with agentId", async () => {
    const { callCore, calls } = makeCallCore({});
    const handler = getHandler("zana_agent_status");
    await handler({ agentId: "a1" }, { callCore });
    expect(calls[0].op).toBe("agent_status");
    expect(calls[0].args.agentId).toBe("a1");
  });

  it("zana_agent_result calls agent_result with agentId", async () => {
    const { callCore, calls } = makeCallCore(null);
    const handler = getHandler("zana_agent_result");
    await handler({ agentId: "a2" }, { callCore });
    expect(calls[0].op).toBe("agent_result");
    expect(calls[0].args.agentId).toBe("a2");
  });

  it("zana_kill_agent calls kill_agent with agentId", async () => {
    const { callCore, calls } = makeCallCore({ killed: true });
    const handler = getHandler("zana_kill_agent");
    await handler({ agentId: "a3" }, { callCore });
    expect(calls[0].op).toBe("kill_agent");
    expect(calls[0].args.agentId).toBe("a3");
  });
});
