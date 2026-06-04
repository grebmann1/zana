// Unit tests for registrations/channels.ts
//
// Behaviours tested:
//   - Tool definitions: expected nine tool names, required fields on key tools
//   - zana_send_message: resolves toAgentName → toAgentId via callCore,
//     errors when neither id nor name supplied, errors when name not found,
//     defaults priority to "normal" and requiresAck to false,
//     threads callerAgentId → fromAgentId
//   - zana_channel_history: defaults limit to 50
//   - All other handlers: thin callCore passthrough smoke tests
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { channels } from "../../src/registrations/channels.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (channels.handlers as Record<string, Handler>)[name];
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

describe("channels tool definitions", () => {
  const toolNames = channels.tools.map((t) => t.name);

  it("exposes the expected nine tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_discover_agents",
        "zana_ask_agent",
        "zana_check_inbox",
        "zana_send_message",
        "zana_publish_channel",
        "zana_subscribe_channel",
        "zana_list_channels",
        "zana_channel_history",
        "zana_send_ack",
      ]),
    );
    expect(toolNames).toHaveLength(9);
  });

  it("zana_ask_agent requires toAgentId and question", () => {
    const tool = channels.tools.find((t) => t.name === "zana_ask_agent")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["toAgentId", "question"]));
  });

  it("zana_send_message requires type and payload", () => {
    const tool = channels.tools.find((t) => t.name === "zana_send_message")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["type", "payload"]));
  });

  it("zana_publish_channel requires channel, type, and payload", () => {
    const tool = channels.tools.find((t) => t.name === "zana_publish_channel")!;
    expect(tool.inputSchema.required).toEqual(
      expect.arrayContaining(["channel", "type", "payload"]),
    );
  });

  it("zana_send_ack requires messageId and status", () => {
    const tool = channels.tools.find((t) => t.name === "zana_send_ack")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["messageId", "status"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_send_message — non-trivial routing logic
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_send_message handler", () => {
  const handler = getHandler("zana_send_message");

  it("sends directly when toAgentId is provided", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await handler(
      { toAgentId: "agent-1", type: "status", payload: { kind: "text", content: "hi" } },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].op).toBe("send_message");
    expect(calls[0].args.toAgentId).toBe("agent-1");
  });

  it("resolves toAgentName via resolve_agent_name when toAgentId is absent", async () => {
    const calls: Captured[] = [];
    const callCore = (op: string, args: Record<string, unknown> = {}) => {
      calls.push({ op, args });
      if (op === "resolve_agent_name") return Promise.resolve("resolved-uuid");
      return Promise.resolve({ ok: true });
    };
    await handler(
      { toAgentName: "synthesizer", type: "finding", payload: { kind: "text", content: "done" } },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].op).toBe("resolve_agent_name");
    expect(calls[0].args.name).toBe("synthesizer");
    expect(calls[1].op).toBe("send_message");
    expect(calls[1].args.toAgentId).toBe("resolved-uuid");
  });

  it("returns error when toAgentName resolves to nothing", async () => {
    const callCore = (_op: string, _args: Record<string, unknown> = {}) =>
      Promise.resolve(null);
    const result = await handler(
      { toAgentName: "ghost", type: "question", payload: { kind: "text", content: "?" } },
      { callCore, callerAgentId: null },
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("ghost") });
  });

  it("returns error when neither toAgentId nor toAgentName is provided", async () => {
    const { callCore } = makeCallCore({ ok: true });
    const result = await handler(
      { type: "status", payload: { kind: "text", content: "x" } },
      { callCore, callerAgentId: null },
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("defaults priority to 'normal' when not supplied", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await handler(
      { toAgentId: "a1", type: "status", payload: { kind: "text", content: "x" } },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.priority).toBe("normal");
  });

  it("forwards explicit priority unchanged", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await handler(
      { toAgentId: "a1", type: "request", payload: { kind: "text", content: "urgent" }, priority: "urgent" },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.priority).toBe("urgent");
  });

  it("defaults requiresAck to false", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await handler(
      { toAgentId: "a1", type: "status", payload: { kind: "text", content: "x" } },
      { callCore, callerAgentId: null },
    );
    expect(calls[0].args.requiresAck).toBe(false);
  });

  it("threads callerAgentId into fromAgentId", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await handler(
      { toAgentId: "a2", type: "handoff", payload: { kind: "text", content: "over" } },
      { callCore, callerAgentId: "caller-42" },
    );
    expect(calls[0].args.fromAgentId).toBe("caller-42");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_channel_history — default limit
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_channel_history handler", () => {
  const handler = getHandler("zana_channel_history");

  it("defaults limit to 50 when not provided", async () => {
    const { callCore, calls } = makeCallCore([]);
    await handler({ channel: "findings" }, { callCore });
    expect(calls[0].op).toBe("channel_history");
    expect(calls[0].args.limit).toBe(50);
  });

  it("forwards explicit limit unchanged", async () => {
    const { callCore, calls } = makeCallCore([]);
    await handler({ channel: "blockers", limit: 10 }, { callCore });
    expect(calls[0].args.limit).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough handlers (smoke tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough handlers", () => {
  it("zana_discover_agents calls discover_agents", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_discover_agents");
    await handler({ query: "worker" }, { callCore });
    expect(calls[0].op).toBe("discover_agents");
    expect(calls[0].args.query).toBe("worker");
  });

  it("zana_ask_agent calls ask_agent with toAgentId and question", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    const handler = getHandler("zana_ask_agent");
    await handler({ toAgentId: "a1", question: "are you done?" }, { callCore });
    expect(calls[0].op).toBe("ask_agent");
    expect(calls[0].args.toAgentId).toBe("a1");
    expect(calls[0].args.question).toBe("are you done?");
  });

  it("zana_check_inbox calls check_inbox", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_check_inbox");
    await handler({}, { callCore });
    expect(calls[0].op).toBe("check_inbox");
  });

  it("zana_publish_channel calls publish_channel with channel, type, payload", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    const handler = getHandler("zana_publish_channel");
    await handler(
      { channel: "findings", type: "finding", payload: { kind: "text", content: "x" } },
      { callCore, callerAgentId: "pub-1" },
    );
    expect(calls[0].op).toBe("publish_channel");
    expect(calls[0].args.channel).toBe("findings");
  });

  it("zana_subscribe_channel calls subscribe_channel with channel and agentId", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    const handler = getHandler("zana_subscribe_channel");
    await handler({ channel: "blockers" }, { callCore, callerAgentId: "sub-2" });
    expect(calls[0].op).toBe("subscribe_channel");
    expect(calls[0].args.channel).toBe("blockers");
    expect(calls[0].args.agentId).toBe("sub-2");
  });

  it("zana_list_channels calls list_channels", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_list_channels");
    await handler({}, { callCore });
    expect(calls[0].op).toBe("list_channels");
  });

  it("zana_send_ack calls send_ack with messageId, status, and agentId from context", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    const handler = getHandler("zana_send_ack");
    await handler(
      { messageId: "msg-99", status: "completed", response: "done" },
      { callCore, callerAgentId: "ack-agent" },
    );
    expect(calls[0].op).toBe("send_ack");
    expect(calls[0].args.messageId).toBe("msg-99");
    expect(calls[0].args.status).toBe("completed");
    expect(calls[0].args.agentId).toBe("ack-agent");
  });
});
