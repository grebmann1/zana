// Unit tests for packages/core/src/core.ts
// Focus: init() wires up the workspace, emits ZANA_READY, and returns a
//        shutdown function. All cross-package deps are stubbed — no real
//        network, no real Claude, no real fs side-effects.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// @ts-ignore – Node's built-in CJS Module (not a typed package export)
import NodeModule from "node:module";

// ── Stub eager internal imports (resolved relative to core.ts at load time) ──
vi.mock("@zana-ai/core/src/events/bus.ts", () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  EVENTS: { ZANA_READY: "zana:ready", ZANA_SHUTDOWN: "zana:shutdown" },
}));
vi.mock("@zana-ai/core/src/agents/profile-store.ts", () => ({}));
// zombie-reaper is lazy-required inside init() via require("./agents/zombie-reaper").
// With ssr.noExternal, Vite processes that require through its module registry so
// vi.mock() intercepts it correctly (Module._load patching is kept as a CJS fallback).
vi.mock("@zana-ai/core/src/agents/zombie-reaper.ts", () => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@zana-ai/core/src/agents/manager.ts", () => ({
  updateAgentFromHook: vi.fn(),
  handleOrchestratorCommand: vi.fn().mockResolvedValue("agent-1"),
  listAgents: vi.fn().mockReturnValue([]),
}));
vi.mock("@zana-ai/core/src/events/log.ts", () => ({
  init: vi.fn(), append: vi.fn(), close: vi.fn(),
}));
vi.mock("@zana-ai/core/src/daemon/registry.ts", () => ({
  cleanStale: vi.fn(),
  generateDaemonId: vi.fn().mockReturnValue("d-test-1"),
  register: vi.fn(),
  startHeartbeat: vi.fn().mockReturnValue(vi.fn()),
  deregister: vi.fn(),
}));
vi.mock("@zana-ai/core/src/persistence.ts", () => ({
  recoverOrphanedAgents: vi.fn().mockReturnValue({ adopted: [], lost: [] }),
  startPeriodicCompaction: vi.fn(),
  stopPeriodicCompaction: vi.fn(),
  snapshotAgents: vi.fn(),
}));
vi.mock("@zana-ai/core/src/events/service.ts", () => ({ init: vi.fn(), stop: vi.fn() }));
vi.mock("@zana-ai/core/src/project/workspace-context.ts", () => ({
  isInitialized: vi.fn().mockReturnValue(true),
  init: vi.fn(),
  getProjectPaths: vi.fn().mockReturnValue({
    ticketsDir: "/tmp/.zana/tickets", projectDir: "/tmp/.zana",
  }),
}));
vi.mock("@zana-ai/core/src/modules/loader.ts", () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));
// zombie-reaper is lazy-required inside init() via a plain CJS require("./agents/zombie-reaper").
// Because @zana-ai/core has no "type":"module", Vite does not apply its SSR require-transform
// to this file, so the call falls through to Node's native Module._load — which can't find a
// .js file.  vi.mock() only intercepts ESM-style loads, so we must patch Module._load directly.
const zombieReaperStub = { start: vi.fn(), stop: vi.fn() };
const CJSModule = (NodeModule as any).Module ?? NodeModule;
const _origLoad = CJSModule._load.bind(CJSModule);
CJSModule._load = function (request: string, ...rest: any[]) {
  if (request === "./agents/zombie-reaper") return zombieReaperStub;
  return _origLoad(request, ...rest);
};

// ── Stub lazy cross-package requires (called inside init()) ───────────────
vi.mock("@zana-ai/server", () => ({
  hooks: {
    server: {
      startHookServer: vi.fn().mockResolvedValue({ port: 47900, stop: vi.fn() }),
      setSwarmModules: vi.fn(),
    },
    installer: {
      isHooksInstalled: vi.fn().mockReturnValue(true),
      installHooks: vi.fn(),
      installMcpServer: vi.fn(),
    },
  },
  api: {
    healthMonitor: { init: vi.fn(), stop: vi.fn() },
    server: { start: vi.fn(), stop: vi.fn() },
  },
}));
vi.mock("@zana-ai/swarm", () => ({
  router: { recoverFromDisk: vi.fn().mockReturnValue(0), peekInbox: vi.fn().mockReturnValue([]) },
  events: {}, spawner: {},
}));
vi.mock("@zana-ai/intelligence", () => ({
  taskRouter: { init: vi.fn() },
  vectorMemory: { init: vi.fn(), shutdown: vi.fn() },
  backgroundWorkers: { init: vi.fn(), shutdown: vi.fn() },
  goapPlanner: {},
}));
vi.mock("@zana-ai/extras", () => ({
  plugins: { loader: { init: vi.fn() } },
  settings: { skillStore: {} },
}));
vi.mock("@zana-ai/work", () => ({
  teams: { store: { seedDefaults: vi.fn() }, manager: {} },
  runs: { tracker: { init: vi.fn() } },
  tickets: { watcher: { init: vi.fn(), stop: vi.fn() } },
  scheduling: { service: { loadFromDisk: vi.fn(), stopAll: vi.fn() } },
}));

import { init } from "@zana-ai/core/src/core.ts";
import { bus } from "@zana-ai/core/src/events/bus.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  tmpDirs.splice(0).forEach((d) => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });
  delete process.env.ZANA_HOOK_PORT;
  delete process.env.ZANA_ID;
  delete process.env.ZANA_HEADLESS;
});

describe("core.init()", () => {
  it("returns a shutdown function and emits ZANA_READY on the event bus", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-"));
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: false });

    expect(typeof result.shutdown).toBe("function");
    expect(bus.emit).toHaveBeenCalledWith(
      "zana:ready",
      expect.objectContaining({ workspace: ws }),
    );
  });
});
