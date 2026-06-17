/**
 * Unit tests for agents/dispatch.ts — the ticket lifecycle routing branches
 * (ticket_create / claim / comment / update_status / complete).
 *
 * These branches don't reshape data; their whole job is to forward the MCP
 * payload to the right `work.tickets.service` method with the arguments in the
 * right POSITIONAL order. That order is the easy-to-break contract:
 *   claimTicket(ticketId, agentId, agentName, profileId)
 *   completeTicket(ticketId, resultSummary, completedBy)
 *   addComment(ticketId, authorId, authorName, body)
 *   updateStatus(ticketId, status, updatedBy)
 * A silent re-order would corrupt every ticket write while still "passing"
 * any test that only checks the return value — so we assert the call shape.
 *
 * `work` is captured at module-load via lazyRequire("@zana-ai/work"); we inject
 * a controllable fake for that call (the same technique dispatch-ticket-edit
 * uses) and harmless stubs for the statically-imported deps so module load
 * doesn't touch real lifecycle/swarm code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { svc } = vi.hoisted(() => ({
  svc: {
    createTicket: vi.fn(),
    claimTicket: vi.fn(),
    addComment: vi.fn(),
    updateStatus: vi.fn(),
    completeTicket: vi.fn(),
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

describe("handleOrchestratorCommand — ticket lifecycle routing", () => {
  it("ticket_create forwards the whole payload (minus action) and returns the service result", async () => {
    svc.createTicket.mockReturnValue({ id: "T-1" });
    const result = await call("ticket_create", { title: "Fix bug", priority: "high" });
    expect(svc.createTicket).toHaveBeenCalledWith({ title: "Fix bug", priority: "high" });
    expect(result).toEqual({ id: "T-1" });
  });

  it("ticket_claim forwards (ticketId, agentId, agentName, profileId) in order", async () => {
    await call("ticket_claim", {
      ticketId: "T-1",
      agentId: "a1",
      agentName: "Alice",
      profileId: "p1",
    });
    expect(svc.claimTicket).toHaveBeenCalledWith("T-1", "a1", "Alice", "p1");
  });

  it("ticket_comment forwards (ticketId, authorId, authorName, body) in order", async () => {
    await call("ticket_comment", {
      ticketId: "T-1",
      authorId: "a1",
      authorName: "Alice",
      body: "looks good",
    });
    expect(svc.addComment).toHaveBeenCalledWith("T-1", "a1", "Alice", "looks good");
  });

  it("ticket_update_status forwards (ticketId, status, updatedBy) in order", async () => {
    await call("ticket_update_status", { ticketId: "T-1", status: "blocked", updatedBy: "a1" });
    expect(svc.updateStatus).toHaveBeenCalledWith("T-1", "blocked", "a1");
  });

  it("ticket_complete forwards (ticketId, resultSummary, completedBy, evidence) in order", async () => {
    await call("ticket_complete", {
      ticketId: "T-1",
      resultSummary: "done",
      completedBy: "a1",
    });
    // evidence is the optional attestation arg (defect #3) — undefined when omitted.
    expect(svc.completeTicket).toHaveBeenCalledWith("T-1", "done", "a1", undefined);
  });

  it("ticket_complete forwards evidence when supplied", async () => {
    const evidence = { branch: "0.8.3", testResult: "1289 passed" };
    await call("ticket_complete", {
      ticketId: "T-1",
      resultSummary: "done",
      completedBy: "a1",
      evidence,
    });
    expect(svc.completeTicket).toHaveBeenCalledWith("T-1", "done", "a1", evidence);
  });
});
