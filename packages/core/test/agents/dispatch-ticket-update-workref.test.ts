// Unit test for the `workRef` persistence arm of the `ticket_update` routing
// branch in agents/dispatch.ts (dispatch.ts:251-255).
//
// `workRef` records where a worker's implementation actually landed (branch /
// worktree / commit) so a later reviewer isn't blind to work committed off the
// checked-out HEAD. The branch persists workRef ONLY when it is a non-null
// OBJECT (`params.workRef && typeof params.workRef === "object"`): a string or
// other scalar must be ignored so a malformed value can't clobber the ticket.
// The sibling dispatch-ticket-update-routing.test.ts covers filesChanged /
// plan / result artifacts but never workRef, which was previously unexercised.
//
// Strategy mirrors dispatch.test.ts: import the raw SUT from /src/ and mock the
// @zana-ai/work service+store behind lazyRequire. The branch's inline
// require("@zana-ai/contracts") hits the real workspace-context singleton, so
// that is left intact and init()-ed to a tmp dir; the only real I/O is an
// mkdirSync into it. No network, no Claude — deterministic.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const mockGetTicket = vi.fn();
  const mockSaveTicket = vi.fn();
  return {
    mockGetTicket,
    mockSaveTicket,
    workMock: {
      tickets: {
        service: {
          getTicket: mockGetTicket,
          addComment: vi.fn(),
          updateStatus: vi.fn(),
          completeTicket: vi.fn(),
          updateReviewPhase: vi.fn(),
        },
        store: { saveTicket: mockSaveTicket },
      },
      scheduling: { service: {} },
      runs: { artifacts: {} },
    },
  };
});

// Override only lazyRequire (so `work` resolves to the controllable mock); keep
// the REAL workspace-context (init / getProjectPaths) intact, because the
// ticket_update branch calls `require("@zana-ai/contracts")` at runtime — that
// inline require hits the real module singleton, so getProjectPaths must be the
// real, initialized one.
vi.mock("@zana-ai/contracts", async (orig) => {
  const actual: any = await orig();
  return { ...actual, lazyRequire: () => h.workMock };
});
vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({}));
vi.mock("@zana-ai/core/src/agents/lifecycle.ts", () => ({
  spawnHeadlessAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  killAgent: vi.fn(),
  checkSystemResources: vi.fn(),
  recordSpawnOverload: vi.fn(),
  clearSpawnOverloadStreak: vi.fn(),
  getSpawnThrottleStreakLimit: vi.fn(),
  getMaxConcurrentAgents: vi.fn(),
}));
vi.mock("@zana-ai/core/src/agents/team-runtime.ts", () => ({}));
vi.mock("@zana-ai/swarm", () => ({ router: {}, events: {}, spawner: {} }));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

const call = (params: Record<string, any>) =>
  handleOrchestratorCommand({ action: "ticket_update", ...params }, null);

let tmpWs: string;
let realContracts: any;

beforeAll(async () => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "zana-workref-"));
  fs.mkdirSync(path.join(tmpWs, ".zana"), { recursive: true });
  // Same singleton the inline require("@zana-ai/contracts") in the branch hits.
  realContracts = await vi.importActual<Record<string, any>>("@zana-ai/contracts");
  realContracts.init(tmpWs);
});

afterAll(() => {
  try { realContracts?._resetForTesting?.(); } catch {}
  try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — ticket_update workRef", () => {
  it("persists an object workRef onto the ticket and saves it", async () => {
    h.mockGetTicket.mockReturnValue({ id: "t1" });
    const workRef = { branch: "feat/x", worktree: "/tmp/wt", commit: "abc123" };

    const result = await call({ ticketId: "t1", workRef });

    expect(result).toEqual({ ok: true, ticketId: "t1" });
    expect(h.mockSaveTicket).toHaveBeenCalled();
    const saved = h.mockSaveTicket.mock.calls.at(-1)![0];
    expect(saved.workRef).toEqual(workRef);
  });

  it("ignores a non-object (string) workRef so a scalar cannot clobber the ticket", async () => {
    h.mockGetTicket.mockReturnValue({ id: "t2" });

    await call({ ticketId: "t2", workRef: "feat/x" });

    const saved = h.mockSaveTicket.mock.calls.at(-1)![0];
    expect(saved.workRef).toBeUndefined();
  });

  it("returns a not-found error and never saves for an unknown ticket", async () => {
    h.mockGetTicket.mockReturnValue(undefined);

    const result = await call({ ticketId: "missing", workRef: { branch: "x" } });

    expect(result).toEqual({ error: "ticket not found" });
    expect(h.mockSaveTicket).not.toHaveBeenCalled();
  });
});
