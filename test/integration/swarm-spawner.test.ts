import { describe, it, expect } from "vitest";
import * as spawner from "@zana/core/src/swarm/spawner.ts";

describe("swarm/spawner", () => {
  describe("listSubHives", () => {
    it("returns an array", () => {
      const result = spawner.listSubHives();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getSubHive", () => {
    it("returns null for unknown hive", () => {
      const result = spawner.getSubHive("nonexistent-hive");
      expect(result).toBeNull();
    });
  });

  describe("stopSubHive", () => {
    it("returns error for unknown hive", () => {
      const result = spawner.stopSubHive("nonexistent-hive");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("getSubHivePorts", () => {
    it("returns an array of ports", () => {
      const ports = spawner.getSubHivePorts();
      expect(Array.isArray(ports)).toBe(true);
    });
  });

  describe("getSubHiveApiPorts", () => {
    it("returns an array of API ports", () => {
      const ports = spawner.getSubHiveApiPorts();
      expect(Array.isArray(ports)).toBe(true);
    });
  });

  describe("getSubHiveAgents", () => {
    it("returns empty for unknown hive", async () => {
      const agents = await spawner.getSubHiveAgents("nonexistent");
      expect(agents).toEqual([]);
    });
  });

  describe("instructSubHive", () => {
    it("returns error for unknown hive", async () => {
      const result = await spawner.instructSubHive("nonexistent", "hello");
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
