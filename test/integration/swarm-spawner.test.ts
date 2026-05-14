import { describe, it, expect } from "vitest";
import * as spawner from "@zana/swarm/src/swarm/spawner.ts";

describe("swarm/spawner", () => {
  describe("listSubDaemons", () => {
    it("returns an array", () => {
      const result = spawner.listSubDaemons();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getSubDaemon", () => {
    it("returns null for unknown hive", () => {
      const result = spawner.getSubDaemon("nonexistent-hive");
      expect(result).toBeNull();
    });
  });

  describe("stopSubDaemon", () => {
    it("returns error for unknown hive", () => {
      const result = spawner.stopSubDaemon("nonexistent-hive");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("getSubDaemonPorts", () => {
    it("returns an array of ports", () => {
      const ports = spawner.getSubDaemonPorts();
      expect(Array.isArray(ports)).toBe(true);
    });
  });

  describe("getSubDaemonApiPorts", () => {
    it("returns an array of API ports", () => {
      const ports = spawner.getSubDaemonApiPorts();
      expect(Array.isArray(ports)).toBe(true);
    });
  });

  describe("getSubDaemonAgents", () => {
    it("returns empty for unknown hive", async () => {
      const agents = await spawner.getSubDaemonAgents("nonexistent");
      expect(agents).toEqual([]);
    });
  });

  describe("instructSubDaemon", () => {
    it("returns error for unknown hive", async () => {
      const result = await spawner.instructSubDaemon("nonexistent", "hello");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("onChange", () => {
    it("returns unsubscribe function", () => {
      const unsub = spawner.onChange(() => {});
      expect(typeof unsub).toBe("function");
      unsub();
    });
  });

  describe("updateHeartbeat", () => {
    it("does nothing for unknown hive (no throw)", () => {
      expect(() => spawner.updateHeartbeat("nonexistent")).not.toThrow();
    });
  });
});
