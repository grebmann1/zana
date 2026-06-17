/**
 * Unit tests for agents/dispatch.ts — the `ticket_get`, `ticket_list`, and
 * `ticket_add_to_sprint` routing branches.
 *
 * These three actions delegate straight to the ticket service reached lazily
 * via `lazyRequire("@zana-ai/work").tickets.service` (dispatch.ts:33, 193-221).
 * They are the read/membership paths an MCP caller relies on, and unlike
 * ticket_create / ticket_complete (covered in dispatch-ticket-lifecycle-routing)
 * and ticket_edit / ticket_update (covered elsewhere) they had no coverage. The
 * contract under test is purely routing: each action must call the right
 * service method with the right positional args and return its result verbatim.
 *
 * The shared dispatch.test.ts mocks lazy-require with a generic Proxy that makes
 * `work.tickets.service` unusable, so these branches are untested there. This
 * file injects a controllable ticket service instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetTicket, mockListTickets, mockAddTicketToSprint } = vi.hoisted(() => ({
  mockGetTicket: vi.fn(),
  mockListTickets: vi.fn(),
  mockAddTicketToSprint: vi.fn(),
}));

// `work` is captured at module load via lazyRequire("@zana-ai/work"); hand back
// a controllable fake for that call and a harmless Proxy for the skillStore
// factory form so module load doesn't blow up.
vi.mock("@zana-ai/contracts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return {
        tickets: {
          service: {
            getTicket: mockGetTicket,
            listTickets: mockListTickets,
            addTicketToSprint: mockAddTicketToSprint,
          },
        },
      };
    }
    return new Proxy({}, { get: () => vi.fn(() => ({})) });
  },
}));

// Imported/required at module load — stub so no real lifecycle/swarm loads.
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

describe("handleOrchestratorCommand — ticket_get", () => {
  it("looks up the single ticket by id and returns it verbatim", async () => {
    const ticket = { id: "T-1", title: "Fix bug", status: "in-progress" };
    mockGetTicket.mockReturnValue(ticket);
    const result = await call("ticket_get", { ticketId: "T-1" });
    expect(result).toBe(ticket);
    expect(mockGetTicket).toHaveBeenCalledWith("T-1");
  });
});

describe("handleOrchestratorCommand — ticket_list", () => {
  it("forwards the full params object as the list filter and returns the result", async () => {
    const tickets = [{ id: "T-1" }, { id: "T-2" }];
    mockListTickets.mockReturnValue(tickets);
    const filter = { status: "backlog", sprintId: "S-1" };
    const result = await call("ticket_list", filter);
    expect(result).toBe(tickets);
    // params (action stripped by the caller) is passed straight through as the filter.
    expect(mockListTickets).toHaveBeenCalledWith(filter);
  });
});

describe("handleOrchestratorCommand — ticket_add_to_sprint", () => {
  it("passes ticketId and sprintId positionally to the service", async () => {
    mockAddTicketToSprint.mockReturnValue({ ok: true });
    const result = await call("ticket_add_to_sprint", { ticketId: "T-9", sprintId: "S-3" });
    expect(result).toEqual({ ok: true });
    expect(mockAddTicketToSprint).toHaveBeenCalledWith("T-9", "S-3");
  });
});
