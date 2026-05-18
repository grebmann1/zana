// Verifies the inflightAgents Map TTL + sweep behavior. Without sweeping,
// the Map leaks one entry per hung/SIGKILL'd spawn-agent fire — see auditor
// finding 9f79873a.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler inflightAgents TTL sweep", () => {
  let tmpDir: string;
  let svc: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sched-inflight-leak-"));
    const ws = await import("@zana/core/src/project/workspace-context.ts");
    ws.init(tmpDir);
    svc = await import("@zana/work/src/scheduling/service.ts");
    // Drain anything that might have leaked over from prior suites in the
    // same vitest worker. Sweep with a very large now-cutoff effect by
    // first dropping any entries that are already older than our TTL.
    svc.sweepInflightAgents();
  });

  it("prunes inflight entries older than the TTL and keeps fresh ones", () => {
    const now = Date.now();
    const TEN_MIN_AGO = now - 10 * 60 * 1000;

    // Stale entry — should be swept.
    svc._trackAgentForTest("agent-stale", "schedule-A", TEN_MIN_AGO);
    // Fresh entry — should survive.
    svc._trackAgentForTest("agent-fresh", "schedule-B", now);

    const before = svc._getInflightAgentsForTest();
    expect(before.find((e: any) => e.agentId === "agent-stale")).toBeTruthy();
    expect(before.find((e: any) => e.agentId === "agent-fresh")).toBeTruthy();

    const pruned = svc.sweepInflightAgents();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const after = svc._getInflightAgentsForTest();
    expect(after.find((e: any) => e.agentId === "agent-stale")).toBeUndefined();
    expect(after.find((e: any) => e.agentId === "agent-fresh")).toBeTruthy();
  });

  it("sweep is a no-op when all entries are fresh", () => {
    const now = Date.now();
    svc._trackAgentForTest("agent-1", "schedule-1", now);
    svc._trackAgentForTest("agent-2", "schedule-2", now - 60 * 1000); // 1 min ago

    // Reset baseline: prune anything stale leftover from other tests.
    svc.sweepInflightAgents();

    const pruned = svc.sweepInflightAgents();
    expect(pruned).toBe(0);

    const after = svc._getInflightAgentsForTest();
    expect(after.find((e: any) => e.agentId === "agent-1")).toBeTruthy();
    expect(after.find((e: any) => e.agentId === "agent-2")).toBeTruthy();
  });
});
