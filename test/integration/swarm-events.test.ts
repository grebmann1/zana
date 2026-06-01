import { describe, it, expect, beforeEach } from "vitest";
import * as events from "@zana-ai/swarm/src/swarm/events.ts";

beforeEach(() => {
  events.clear();
});

describe("swarm/events", () => {
  describe("addEvent", () => {
    it("stores an event with auto-generated id and timestamp", () => {
      events.addEvent({ type: "progress", summary: "working" });
      const all = events.query();
      expect(all.length).toBe(1);
      expect(all[0].type).toBe("progress");
      expect(all[0].summary).toBe("working");
      expect(typeof all[0].id).toBe("string");
      expect(typeof all[0].timestamp).toBe("number");
    });

    it("preserves existing id and timestamp", () => {
      events.addEvent({ id: "custom-id", timestamp: 12345, type: "error", summary: "fail" });
      const all = events.query();
      expect(all[0].id).toBe("custom-id");
      expect(all[0].timestamp).toBe(12345);
    });

    it("enforces ring buffer max (1000)", () => {
      for (let i = 0; i < 1050; i++) {
        events.addEvent({ type: "progress", summary: `event-${i}` });
      }
      const all = events.query();
      expect(all.length).toBe(1000);
      // Oldest dropped, newest kept
      expect(all[0].summary).toBe("event-50");
      expect(all[999].summary).toBe("event-1049");
    });
  });

  describe("query", () => {
    it("filters by since timestamp", () => {
      events.addEvent({ timestamp: 100, type: "progress", summary: "old" });
      events.addEvent({ timestamp: 200, type: "progress", summary: "new" });
      const result = events.query({ since: 150 });
      expect(result.length).toBe(1);
      expect(result[0].summary).toBe("new");
    });

    it("filters by daemonId", () => {
      events.addEvent({ daemonId: "daemon-a", type: "progress", summary: "a" });
      events.addEvent({ daemonId: "daemon-b", type: "progress", summary: "b" });
      const result = events.query({ daemonId: "daemon-a" });
      expect(result.length).toBe(1);
      expect(result[0].summary).toBe("a");
    });

    it("filters by type", () => {
      events.addEvent({ type: "progress", summary: "p" });
      events.addEvent({ type: "error", summary: "e" });
      events.addEvent({ type: "completed", summary: "c" });
      const result = events.query({ type: "error" });
      expect(result.length).toBe(1);
      expect(result[0].summary).toBe("e");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        events.addEvent({ type: "progress", summary: `item-${i}` });
      }
      const result = events.query({ limit: 3 });
      expect(result.length).toBe(3);
      // Returns last 3
      expect(result[0].summary).toBe("item-7");
    });

    it("combines multiple filters", () => {
      events.addEvent({ timestamp: 100, daemonId: "a", type: "progress", summary: "1" });
      events.addEvent({ timestamp: 200, daemonId: "a", type: "error", summary: "2" });
      events.addEvent({ timestamp: 300, daemonId: "b", type: "progress", summary: "3" });
      events.addEvent({ timestamp: 400, daemonId: "a", type: "progress", summary: "4" });

      const result = events.query({ since: 150, daemonId: "a", type: "progress" });
      expect(result.length).toBe(1);
      expect(result[0].summary).toBe("4");
    });
  });

  describe("pending", () => {
    it("returns all events when no since provided", () => {
      events.addEvent({ type: "progress", summary: "x" });
      events.addEvent({ type: "error", summary: "y" });
      const result = events.pending();
      expect(result.length).toBe(2);
    });

    it("returns events after since timestamp", () => {
      events.addEvent({ timestamp: 100, type: "progress", summary: "old" });
      events.addEvent({ timestamp: 200, type: "progress", summary: "new" });
      const result = events.pending(150);
      expect(result.length).toBe(1);
      expect(result[0].summary).toBe("new");
    });
  });

  describe("clear", () => {
    it("removes all events", () => {
      events.addEvent({ type: "progress", summary: "test" });
      expect(events.query().length).toBe(1);
      events.clear();
      expect(events.query().length).toBe(0);
    });
  });

  describe("onChange", () => {
    it("calls listener on new event", () => {
      const received = [];
      const unsub = events.onChange((evt) => received.push(evt));
      events.addEvent({ type: "progress", summary: "hello" });
      expect(received.length).toBe(1);
      expect(received[0].summary).toBe("hello");
      unsub();
    });

    it("unsubscribe stops notifications", () => {
      const received = [];
      const unsub = events.onChange((evt) => received.push(evt));
      events.addEvent({ type: "progress", summary: "before" });
      unsub();
      events.addEvent({ type: "progress", summary: "after" });
      expect(received.length).toBe(1);
    });
  });
});
