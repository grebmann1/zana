/**
 * Unit test for agents/dispatch.ts — the `ticket_edit` routing branch.
 *
 * Unlike the other dispatch branches, `ticket_edit` does real reshaping before
 * delegating: it destructures `{ ticketId, updatedBy, ...fields }` and strips
 * every `undefined`-valued entry from `fields` before calling
 * `ticketService.updateTicket(ticketId, cleanFields, updatedBy)`
 * (dispatch.ts:211-218). That filter is the contract an MCP caller relies on —
 * passing `description: undefined` must NOT clobber the stored description.
 *
 * The shared dispatch.test.ts mocks lazy-require with a generic Proxy that
 * makes `work.tickets.service` unusable, so the ticketing branches are
 * untested there. This file injects a controllable `work` mock instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpdateTicket } = vi.hoisted(() => ({
  mockUpdateTicket: vi.fn(),
}));

// `work` is captured at module-load via lazyRequire("@zana-ai/work"); return a
// controllable fake for that call and a harmless Proxy for the skillStore
// factory form so module load doesn't blow up.
vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { tickets: { service: { updateTicket: mockUpdateTicket } } };
    }
    return new Proxy({}, { get: () => vi.fn(() => ({})) });
  },
}));

// Required/imported at module load — stub so no real lifecycle/swarm loads.
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

vi.mock("@zana-ai/swarm", () => ({
  router: {},
  events: {},
  spawner: {},
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — ticket_edit", () => {
  it("strips undefined fields and forwards only defined ones to updateTicket", async () => {
    mockUpdateTicket.mockReturnValue({ ok: true });

    const result = await handleOrchestratorCommand(
      {
        action: "ticket_edit",
        ticketId: "T-1",
        updatedBy: "alice",
        title: "New title",
        description: undefined, // must be dropped, not sent as undefined
        priority: "high",
        assignee: undefined, // must be dropped
      },
      null,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpdateTicket).toHaveBeenCalledTimes(1);
    // ticketId and updatedBy are passed positionally; only DEFINED fields remain.
    expect(mockUpdateTicket).toHaveBeenCalledWith(
      "T-1",
      { title: "New title", priority: "high" },
      "alice",
    );
    // Guard against the undefined keys silently riding along in the payload.
    const cleanFields = mockUpdateTicket.mock.calls[0][1];
    expect(cleanFields).not.toHaveProperty("description");
    expect(cleanFields).not.toHaveProperty("assignee");
  });

  it("forwards an empty field object when only ticketId/updatedBy are supplied", async () => {
    mockUpdateTicket.mockReturnValue({ ok: true });

    await handleOrchestratorCommand(
      { action: "ticket_edit", ticketId: "T-2", updatedBy: "bob" },
      null,
    );

    expect(mockUpdateTicket).toHaveBeenCalledWith("T-2", {}, "bob");
  });
});
