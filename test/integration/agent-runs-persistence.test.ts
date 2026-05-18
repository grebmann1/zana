import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";

const TEST_WORKSPACE = path.join(os.tmpdir(), `zana-test-runs-${Date.now()}`);
const MANAGER_SRC_PATH = path.resolve(
  __dirname,
  "../../packages/core/src/agents/manager.ts"
);

describe("agent-runs-persistence", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
  });

  afterEach(() => {
    try {
      const runsDir = workspaceContext.getProjectPaths().runsDir;
      if (fs.existsSync(runsDir)) {
        for (const f of fs.readdirSync(runsDir)) {
          try { fs.unlinkSync(path.join(runsDir, f)); } catch {}
        }
      }
    } catch {}
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("workspace-context exposes a runsDir under the project dir", () => {
    const paths = workspaceContext.getProjectPaths();
    expect(paths.runsDir).toBeTruthy();
    expect(paths.runsDir.endsWith(path.join("runs"))).toBe(true);
    // Sanity: the runsDir must live under the project dir.
    expect(paths.runsDir.startsWith(paths.projectDir)).toBe(true);
  });

  it("a write to <runsDir>/<agentId>.json round-trips JSON cleanly", () => {
    const runsDir = workspaceContext.getProjectPaths().runsDir;
    fs.mkdirSync(runsDir, { recursive: true });

    const fakeAgentId = "test-agent-runs-roundtrip";
    const record = {
      id: fakeAgentId,
      profileId: "test-profile",
      profileName: "Test Profile",
      mode: "headless",
      state: "terminated",
      result: "Hello world",
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      durationMs: 1234,
      terminatedAt: new Date().toISOString(),
      exitCode: 0,
    };
    fs.writeFileSync(
      path.join(runsDir, `${fakeAgentId}.json`),
      JSON.stringify(record, null, 2),
      "utf8"
    );

    const recordPath = path.join(runsDir, `${fakeAgentId}.json`);
    expect(fs.existsSync(recordPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    expect(parsed.id).toBe(fakeAgentId);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.terminatedAt).toBeTruthy();
  });

  // Behavioral: assert manager.ts contains the persistence write in the
  // close-handler. Behavioral spawn-and-watch is impractical in unit tests
  // because spawnHeadlessAgent transitively loads modules/config which uses
  // CJS-style requires that vitest's resolver can't always unwind. The
  // structural check makes a regression noisy without depending on a live
  // `claude` binary.
  it("manager.ts persists agent records on close and truncates oversize results", () => {
    const src = fs.readFileSync(MANAGER_SRC_PATH, "utf8");

    // Run record write into runsDir
    expect(src).toMatch(/runsDir\s*=\s*workspaceContext\.getProjectPaths\(\)\.runsDir/);
    expect(src).toMatch(/\bpath(?:Mod)?\.join\(runsDir,\s*`\$\{agentId\}\.json`\)/);

    // The write happens inside child.on("close", ...).
    const closeHandlerStart = src.indexOf('child.on("close"');
    expect(closeHandlerStart).toBeGreaterThan(-1);
    const closeBlock = src.slice(closeHandlerStart, closeHandlerStart + 2000);
    expect(closeBlock).toContain("runsDir");
    expect(closeBlock).toContain("writeFileSync");

    // Truncation guard so a runaway agent can't fill disk.
    expect(src).toContain("MAX_RESULT_BYTES");
    expect(src).toMatch(/100\s*\*\s*1024/);
    expect(src).toContain("truncated");

    // The serialized record must NOT include the live ChildProcess handle
    // (it isn't JSON-serializable and would leak fds).
    expect(src).toMatch(/childProcess:\s*_omit/);

    // terminatedAt + exitCode are part of the record shape.
    expect(src).toContain("terminatedAt");
    expect(src).toContain("exitCode: code");

    // Failure path is non-fatal — write errors must be caught.
    expect(closeBlock).toContain("try");
    expect(closeBlock).toContain("catch");
  });
});
