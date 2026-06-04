// Integration test for packages/core/src/core.ts.
//
// Strategy: redirect HOME and the workspace root to tmpdirs, then exercise
// the real init() against the real cross-package modules. We assert observable
// outcomes — ZANA_READY emitted, shutdown function returned, daemon-registry
// file written under the redirected HOME — instead of stubbing every internal
// module we touch.
//
// External boundaries that stay mocked:
//   • hooks/installer's writes to ~/.claude/settings.json — covered by
//     installer.test.ts and not the subject of this file.
//   • Real `claude` CLI spawning never happens because init() does not spawn
//     agents; the agentManager is a passive listener here.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Hoisted: override HOME before ANY @zana-ai/* module loads ──────────────
// config.ts captures os.homedir() at module-load time, so HOME must be set
// before the first `import` resolves. vi.hoisted() runs before imports.
const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-core-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

// Stop hooks/installer from touching the (test-host's) real ~/.claude on
// macOS where HOME alone is not always honoured by Claude Code. The
// install-hooks code path is unit-tested in installer.test.ts.
process.env.ZANA_SKIP_MCP_INSTALL = "1";

// We don't want to mutate the real claude settings.json. Force isClaudeHost
// false so isHooksInstalled() short-circuits and installHooks() is skipped.
// (server's installer reads from @zana-ai/core/dist/src/host/detect.js.)
vi.mock("@zana-ai/core/dist/src/host/detect.js", () => ({
  isClaudeHost: () => false,
}));

// Import the BUILT core — production code path. `require("./agents/zombie-reaper")`
// inside core.ts resolves cleanly here because dist is real CJS .js (no Vite
// SSR transform required).
import * as core from "@zana-ai/core";
const init = (core as any).init;
const bus = (core as any).events.bus;
const EVENTS = (core as any).events.EVENTS;
const workspaceContext = (core as any).project.workspaceContext;

const tmpDirs: string[] = [];

afterAll(() => {
  process.env.HOME = origHome;
  delete process.env.ZANA_SKIP_MCP_INSTALL;
  delete process.env.ZANA_HOOK_PORT;
  delete process.env.ZANA_ID;
  delete process.env.ZANA_HEADLESS;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

afterEach(async () => {
  // Best-effort tmpdir cleanup
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  delete process.env.ZANA_HOOK_PORT;
  delete process.env.ZANA_ID;
  delete process.env.ZANA_HEADLESS;
});

describe("core.init()", { timeout: 30000 }, () => {
  it("returns a shutdown function and emits ZANA_READY on the bus", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    tmpDirs.push(ws);

    const ready = new Promise<any>((resolve) => {
      bus.once(EVENTS.ZANA_READY, (payload: any) => resolve(payload));
    });

    const result = await init({ workspace: ws, headless: false });

    try {
      expect(typeof result.shutdown).toBe("function");
      const readyPayload = await ready;
      expect(readyPayload.workspace).toBe(ws);
      // hookServerHandle is exposed on the result and registered a port.
      expect(typeof result.hookServerHandle.port).toBe("number");
      expect(result.hookServerHandle.port).toBeGreaterThan(0);
      // daemonId is generated when a hook server is bound.
      expect(typeof result.daemonId).toBe("string");
      expect(result.daemonId.length).toBeGreaterThan(0);
      // Workspace context is initialized with the tmp ws as the root.
      // (eventLog creates session dirs lazily; we check the singleton state
      // instead of relying on a specific directory side-effect.)
      expect((core as any).project.workspaceContext.isInitialized()).toBe(true);
      expect((core as any).project.workspaceContext.getWorkspaceRoot()).toBe(path.resolve(ws));
    } finally {
      await result.shutdown();
    }
  });

  it("writes a daemon-registry entry under the redirected HOME", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: true, skipApiServer: true });

    try {
      const daemonsDir = path.join(fakeHome, ".zana", "daemons");
      // The registry writes <id>.json on register().
      const files = fs.existsSync(daemonsDir)
        ? fs.readdirSync(daemonsDir).filter((f) => f.endsWith(".json"))
        : [];
      expect(files.length).toBeGreaterThan(0);
      // Sanity: one of those files should hold our daemonId.
      const found = files.some((f) => f.startsWith(result.daemonId));
      expect(found).toBe(true);
    } finally {
      await result.shutdown();
    }
  });
});
