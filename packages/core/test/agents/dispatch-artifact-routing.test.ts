/**
 * Unit tests for agents/dispatch.ts — the `artifact_*` routing branches.
 *
 * The artifact actions delegate to the content-addressed artifact store reached
 * lazily via `lazyRequire("@zana-ai/work").runs.artifacts` (dispatch.ts:36,
 * 314-333). Two of them do real reshaping the store itself does not:
 *   - artifact_read / artifact_update translate a missing record into a
 *     `{ error: "artifact not found: <id>" }` shape.
 *   - artifact_update destructures `{ artifactId, ...fields }` and forwards only
 *     the remaining fields to updateArtifact(artifactId, fields).
 *   - artifact_delete coerces the store's boolean into `{ ok: <bool> }`.
 *
 * The shared dispatch.test.ts mocks lazy-require with a generic Proxy, so these
 * branches are untested there. This file injects a controllable artifact store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockArtifacts } = vi.hoisted(() => ({
  mockArtifacts: {
    createArtifact: vi.fn(),
    listArtifacts: vi.fn(),
    getArtifact: vi.fn(),
    updateArtifact: vi.fn(),
    deleteArtifact: vi.fn(),
  },
}));

// `work` is captured at module load via lazyRequire("@zana-ai/work"); hand back
// a controllable fake for that call and a harmless Proxy for the skillStore
// factory form so module load doesn't blow up.
vi.mock("@zana-ai/core/src/util/lazy-require.ts", () => ({
  lazyRequire: (arg: any) => {
    if (arg === "@zana-ai/work") {
      return { runs: { artifacts: mockArtifacts } };
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

vi.mock("@zana-ai/swarm", () => ({
  router: {},
  events: {},
  spawner: {},
}));

import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

function call(action: string, params: Record<string, any> = {}) {
  return handleOrchestratorCommand({ action, ...params }, null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleOrchestratorCommand — artifact_create", () => {
  it("forwards the payload (action stripped) to createArtifact and returns its result", async () => {
    const created = { id: "art-9", kind: "doc" };
    mockArtifacts.createArtifact.mockReturnValue(created);
    const result = await call("artifact_create", { kind: "doc", content: "hello" });
    expect(result).toBe(created);
    // The switch strips `action` before delegating; only the payload reaches the store.
    expect(mockArtifacts.createArtifact).toHaveBeenCalledWith({ kind: "doc", content: "hello" });
  });
});

describe("handleOrchestratorCommand — artifact_list", () => {
  it("forwards the filter payload to listArtifacts and returns its result verbatim", async () => {
    const listing = [{ id: "art-1" }, { id: "art-2" }];
    mockArtifacts.listArtifacts.mockReturnValue(listing);
    const result = await call("artifact_list", { kind: "doc" });
    expect(result).toBe(listing);
    expect(mockArtifacts.listArtifacts).toHaveBeenCalledWith({ kind: "doc" });
  });
});

describe("handleOrchestratorCommand — artifact_read", () => {
  it("returns a not-found error shape when the artifact is missing", async () => {
    mockArtifacts.getArtifact.mockReturnValue(undefined);
    const result = await call("artifact_read", { artifactId: "art-404" });
    expect(result).toEqual({ error: "artifact not found: art-404" });
  });

  it("returns the stored artifact when it exists", async () => {
    const artifact = { id: "art-1", content: "hello" };
    mockArtifacts.getArtifact.mockReturnValue(artifact);
    const result = await call("artifact_read", { artifactId: "art-1" });
    expect(result).toBe(artifact);
    expect(mockArtifacts.getArtifact).toHaveBeenCalledWith("art-1");
  });
});

describe("handleOrchestratorCommand — artifact_update", () => {
  it("forwards only the non-id fields to updateArtifact", async () => {
    const updated = { id: "art-1", title: "new" };
    mockArtifacts.updateArtifact.mockReturnValue(updated);
    const result = await call("artifact_update", { artifactId: "art-1", title: "new", tags: ["x"] });
    expect(result).toBe(updated);
    expect(mockArtifacts.updateArtifact).toHaveBeenCalledWith("art-1", { title: "new", tags: ["x"] });
  });

  it("returns a not-found error shape when the artifact is missing", async () => {
    mockArtifacts.updateArtifact.mockReturnValue(undefined);
    const result = await call("artifact_update", { artifactId: "art-404", title: "new" });
    expect(result).toEqual({ error: "artifact not found: art-404" });
  });
});

describe("handleOrchestratorCommand — artifact_delete", () => {
  it("wraps the store's boolean result in an { ok } shape", async () => {
    mockArtifacts.deleteArtifact.mockReturnValue(true);
    const result = await call("artifact_delete", { artifactId: "art-1" });
    expect(result).toEqual({ ok: true });
    expect(mockArtifacts.deleteArtifact).toHaveBeenCalledWith("art-1");
  });
});
