// workflow-engine unit tests — evaluateCondition and MAX_STEPS / MAX_CONCURRENT_RUNS constants.
import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  MAX_STEPS,
  MAX_CONCURRENT_RUNS,
} from "@zana-ai/work/src/scheduling/workflow-engine.ts";

describe("evaluateCondition", () => {
  it("returns true when condition is null/undefined (no gate)", () => {
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition(undefined, {})).toBe(true);
    expect(evaluateCondition("", {})).toBe(true);
  });

  it("evaluates a truthy JS expression", () => {
    expect(evaluateCondition("1 === 1", {})).toBe(true);
    expect(evaluateCondition("ticket.status === 'done'", { ticket: { status: "done" } })).toBe(true);
  });

  it("evaluates a falsy JS expression", () => {
    expect(evaluateCondition("false", {})).toBe(false);
    expect(evaluateCondition("ticket.status === 'done'", { ticket: { status: "open" } })).toBe(false);
  });

  it("coerces truthy values to boolean", () => {
    expect(evaluateCondition("42", {})).toBe(true);
    expect(evaluateCondition("0", {})).toBe(false);
    expect(evaluateCondition("'hello'", {})).toBe(true);
  });

  it("exposes ticket, agent, run as top-level vars", () => {
    const ctx = {
      ticket: { priority: "high" },
      agent: { id: "a1" },
      run: { step: 3 },
    };
    expect(evaluateCondition("ticket.priority === 'high'", ctx)).toBe(true);
    expect(evaluateCondition("agent.id === 'a1'", ctx)).toBe(true);
    expect(evaluateCondition("run.step > 2", ctx)).toBe(true);
  });

  it("treats missing context properties as empty objects (no throw)", () => {
    // ticket/agent/run default to {} when not provided
    expect(evaluateCondition("ticket.foo === undefined", {})).toBe(true);
    expect(evaluateCondition("agent.bar === undefined", {})).toBe(true);
  });

  it("returns false when the expression throws (invalid syntax / runtime error)", () => {
    expect(evaluateCondition("this is not valid js!!!", {})).toBe(false);
    expect(evaluateCondition("null.property", {})).toBe(false);
  });
});

describe("exported constants", () => {
  it("MAX_STEPS is a positive integer (guards against runaway workflows)", () => {
    expect(typeof MAX_STEPS).toBe("number");
    expect(Number.isInteger(MAX_STEPS)).toBe(true);
    expect(MAX_STEPS).toBeGreaterThan(0);
  });

  it("MAX_CONCURRENT_RUNS is a positive integer", () => {
    expect(typeof MAX_CONCURRENT_RUNS).toBe("number");
    expect(Number.isInteger(MAX_CONCURRENT_RUNS)).toBe(true);
    expect(MAX_CONCURRENT_RUNS).toBeGreaterThan(0);
  });
});
