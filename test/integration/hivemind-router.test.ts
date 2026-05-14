import { describe, it, expect, beforeEach } from "vitest";

// Reset module state between tests
let router;
beforeEach(async () => {
  const mod = await import("@zana/core/src/hivemind-router.ts");
  // Re-import doesn't reset module state — we test accumulative behavior
  router = mod;
});

describe("hivemind-router", () => {
  describe("deliverLocal", () => {
    it("delivers a message to an agent inbox", () => {
      const msg = { fromAgentId: "a1", body: "hello", type: "question" };
      router.deliverLocal("target-1", msg);
      const inbox = router.peekInbox("target-1");
      expect(inbox.length).toBeGreaterThanOrEqual(1);
      const last = inbox[inbox.length - 1];
      expect(last.body).toBe("hello");
      expect(last.id).toBeDefined();
      expect(last.sentAt).toBeDefined();
    });

    it("auto-generates id and sentAt if missing", () => {
      const msg = { fromAgentId: "a1", body: "test", type: "question" };
      router.deliverLocal("target-autoid", msg);
      const inbox = router.peekInbox("target-autoid");
      const last = inbox[inbox.length - 1];
      expect(typeof last.id).toBe("string");
      expect(last.id.length).toBeGreaterThan(0);
      expect(typeof last.sentAt).toBe("number");
    });

    it("enforces MAX_INBOX_SIZE by dropping oldest", () => {
      for (let i = 0; i < 1005; i++) {
        router.deliverLocal("overflow-agent", { body: `msg-${i}`, type: "question" });
      }
      const inbox = router.peekInbox("overflow-agent");
      expect(inbox.length).toBeLessThanOrEqual(1000);
      // Oldest messages were dropped, newest remain
      const last = inbox[inbox.length - 1];
      expect(last.body).toBe("msg-1004");
    });
  });

  describe("drainInbox", () => {
    it("returns and clears pending messages", () => {
      router.deliverLocal("drain-agent", { body: "one", type: "question" });
      router.deliverLocal("drain-agent", { body: "two", type: "question" });

      const messages = router.drainInbox("drain-agent");
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[messages.length - 1].body).toBe("two");

      // After drain, inbox should be empty
      const empty = router.drainInbox("drain-agent");
      expect(empty).toEqual([]);
    });

    it("returns empty array for unknown agent", () => {
      expect(router.drainInbox("nonexistent")).toEqual([]);
    });
  });

  describe("peekInbox", () => {
    it("returns messages without clearing", () => {
      router.deliverLocal("peek-agent", { body: "peek-test", type: "question" });
      const first = router.peekInbox("peek-agent");
      const second = router.peekInbox("peek-agent");
      expect(first.length).toBe(second.length);
    });

    it("returns empty array for unknown agent", () => {
      expect(router.peekInbox("no-such-agent")).toEqual([]);
    });
  });

  describe("routeMessage", () => {
    it("rejects invalid message types", async () => {
      const msg = { type: "instruction", toAgentId: "x", body: "do this" };
      const result = await router.routeMessage(msg, [], []);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("invalid message type");
    });

    it("delivers locally if target is in local agents", async () => {
      const localAgents = [{ id: "local-1", terminalId: "term-1" }];
      const msg = { type: "question", toAgentId: "local-1", body: "hi?" };
      const result = await router.routeMessage(msg, localAgents, []);
      expect(result.ok).toBe(true);
      expect(result.delivered).toBe("local");
    });

    it("returns error if target not found anywhere", async () => {
      const msg = { type: "question", toAgentId: "unknown-agent", body: "hi?" };
      const result = await router.routeMessage(msg, [], []);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("discoverAgents", () => {
    it("returns empty before routing table is populated", () => {
      const results = router.discoverAgents("nonexistent-query-xyz");
      expect(results).toEqual([]);
    });
  });

  describe("generateMessageId", () => {
    it("returns a UUID string", () => {
      const id = router.generateMessageId();
      expect(typeof id).toBe("string");
      expect(id.length).toBe(36);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => router.generateMessageId()));
      expect(ids.size).toBe(100);
    });
  });
});
