// Tests for swarm/router — inbox management, channels, acks, routeMessage.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @zana-ai/core before router.ts lazy-requires it.
vi.mock("@zana-ai/core", () => ({
  persistence: {
    persistInboxMessage: vi.fn(),
    persistInboxDrain: vi.fn(),
    persistChannelMessage: vi.fn(),
    recoverInboxes: vi.fn(() => new Map()),
    recoverChannels: vi.fn(() => new Map()),
  },
  util: {
    logger: { getLogger: vi.fn(() => ({ error: vi.fn() })) },
  },
}));

import {
  deliverLocal,
  drainInbox,
  peekInbox,
  subscribeChannel,
  unsubscribeChannel,
  publishToChannel,
  getChannelHistory,
  listChannels,
  requestAck,
  sendAck,
  checkAck,
  cleanExpiredAcks,
  routeMessage,
  generateMessageId,
} from "@zana-ai/swarm/src/swarm/router.ts";

// Each test uses a unique prefix so module-level Maps don't bleed between tests.
let uid = 0;
function id(label = "agent") { return `${label}-${++uid}-${Date.now()}`; }

describe("generateMessageId", () => {
  it("returns a non-empty string unique each call", () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("inbox (deliverLocal / drainInbox / peekInbox)", () => {
  it("delivers a message and peekInbox returns it without clearing", () => {
    const agentId = id();
    deliverLocal(agentId, { type: "question", content: "hello" });
    const peeked = peekInbox(agentId);
    expect(peeked.length).toBe(1);
    expect(peeked[0].content).toBe("hello");
    // peek doesn't clear
    expect(peekInbox(agentId).length).toBe(1);
  });

  it("drainInbox returns all messages then leaves empty inbox", () => {
    const agentId = id();
    deliverLocal(agentId, { type: "status", n: 1 });
    deliverLocal(agentId, { type: "status", n: 2 });
    const drained = drainInbox(agentId);
    expect(drained.length).toBe(2);
    expect(drainInbox(agentId).length).toBe(0);
  });

  it("auto-assigns id and sentAt when missing", () => {
    const agentId = id();
    deliverLocal(agentId, { type: "finding" });
    const [msg] = peekInbox(agentId);
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.sentAt).toBe("number");
  });

  it("peekInbox returns [] for unknown agent", () => {
    expect(peekInbox("unknown-agent-xyz")).toEqual([]);
  });
});

describe("channel pub/sub", () => {
  it("subscribers receive published messages (excluding sender)", () => {
    const ch = id("chan");
    const subscriber = id();
    const sender = id();
    subscribeChannel(ch, subscriber);
    const result = publishToChannel(ch, { type: "status", fromAgentId: sender });
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);
    const inbox = peekInbox(subscriber);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });

  it("sender does not receive their own published message", () => {
    const ch = id("chan");
    const sender = id();
    subscribeChannel(ch, sender);
    const result = publishToChannel(ch, { type: "status", fromAgentId: sender });
    expect(result.delivered).toBe(0); // sender excluded
  });

  it("getChannelHistory respects limit", () => {
    const ch = id("chan");
    for (let i = 0; i < 5; i++) publishToChannel(ch, { type: "finding", i });
    const last2 = getChannelHistory(ch, { limit: 2 });
    expect(last2.length).toBe(2);
  });

  it("unsubscribeChannel removes agent from channel", () => {
    const ch = id("chan");
    const agentId = id();
    subscribeChannel(ch, agentId);
    const r = unsubscribeChannel(ch, agentId);
    expect(r.ok).toBe(true);
  });

  it("unsubscribeChannel returns error for unknown channel", () => {
    const r = unsubscribeChannel("no-such-channel-xyz", id());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it("listChannels includes newly created channel", () => {
    const ch = id("chan");
    publishToChannel(ch, { type: "finding" });
    const list = listChannels();
    expect(list.some((c: any) => c.name === ch)).toBe(true);
  });
});

describe("acknowledgments", () => {
  it("requestAck → sendAck → checkAck returns received status", () => {
    const msgId = generateMessageId();
    const agentId = id();
    requestAck(msgId);
    sendAck(msgId, agentId, "received", "ok");
    const ack = checkAck(msgId);
    expect(ack?.status).toBe("received");
    expect(ack?.agentId).toBe(agentId);
    expect(ack?.response).toBe("ok");
  });

  it("sendAck on unknown messageId returns error", () => {
    const r = sendAck("not-registered", id(), "received");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ack requested/i);
  });

  it("checkAck returns null for unknown messageId", () => {
    expect(checkAck("totally-unknown-id")).toBeNull();
  });

  it("cleanExpiredAcks removes acks older than TTL*2 (via fake time)", () => {
    vi.useFakeTimers();
    const msgId = generateMessageId();
    requestAck(msgId);
    // advance 5 minutes — well past ACK_TTL*2 (4 min)
    vi.advanceTimersByTime(5 * 60_000);
    cleanExpiredAcks();
    expect(checkAck(msgId)).toBeNull();
    vi.useRealTimers();
  });
});

describe("routeMessage", () => {
  it("rejects an unknown message type", async () => {
    const result = await routeMessage(
      { type: "invalid-type", toAgentId: id() },
      [],
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid message type/i);
  });

  it("delivers locally when toAgentId matches a local agent", async () => {
    const agentId = id();
    const result = await routeMessage(
      { type: "question", toAgentId: agentId },
      [{ id: agentId }],
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe("local");
    expect(peekInbox(agentId).length).toBeGreaterThanOrEqual(1);
  });

  it("returns not-found when agent is absent with no sub-daemons", async () => {
    const result = await routeMessage(
      { type: "question", toAgentId: "ghost-agent" },
      [],
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
