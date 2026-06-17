/**
 * Unit test for agents/dispatch.ts — the `ticket_verdict` routing branch.
 *
 * This branch forwards the MCP payload to work.tickets.service.recordVerdict
 * in a fixed POSITIONAL order:
 *   recordVerdict(ticketId, kind, reason, reportedBy, profileLabel)
 * but the dispatch payload names the second slot `verdict`, not `kind`:
 *   recordVerdict(params.ticketId, params.verdict, params.reason,
 *                 params.reportedBy, params.profileLabel)
 * That payload→positional mapping is the easy-to-break contract — a silent
 * re-order (or renaming `verdict` away) would corrupt every reviewer verdict
 * while still returning the service result, so we assert the exact call shape.
 *
 * Mocking mirrors dispatch-ticket-lifecycle-routing.test.ts: `work` is captured
 * at module-load via lazyRequire("@zana-ai/work"), so we inject a controllable
 * fake there and stub the statically-imported deps so load stays inert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { svc } = vi.hoisted(() => ({
  svc: {
    recordVerdict: vi.fn(),
  },
}));

vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { tickets: { service: svc } };
    }
    return new Proxy({}, { get: () => vi.fn(() => ({})) });
  },
}));

vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  killAgent: vi.fn(),
  checkSystemResources: vi.fn(() => null),
  recordSpawnOverload: vi.fn(),
  clearSpawnOverloadStreak: vi.fn(),
  getSpawnThrottleStreakLimit: vi.fn(() => 5),
  getMaxConcurrentAgents: vi.fn(() => 10),
  spawnHeadlessAgent: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({
  getProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));
vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — ticket_verdict routing", () => {
  it("forwards (ticketId, verdict, reason, reportedBy, profileLabel) in order and returns the service result", async () => {
    svc.recordVerdict.mockReturnValue({ ok: true });

    const result = await call("ticket_verdict", {
      ticketId: "T-1",
      verdict: "pass",
      reason: "QA looks good",
      reportedBy: "qa-bot",
      profileLabel: "qa",
    });

    // The payload's `verdict` lands in recordVerdict's `kind` (2nd) slot.
    expect(svc.recordVerdict).toHaveBeenCalledWith("T-1", "pass", "QA looks good", "qa-bot", "qa");
    expect(result).toEqual({ ok: true });
  });
});
