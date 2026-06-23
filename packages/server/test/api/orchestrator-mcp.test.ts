// Unit tests for packages/server/src/api/orchestrator-mcp.ts
//
// The shim is a side-effecting entry-point (it calls require() to start the
// real MCP server) so we do NOT import it — doing so would launch a live
// process inside the test runner.  Instead we verify its two structural
// invariants:
//   1. The target file it delegates to actually exists in the project tree.
//   2. The shim itself is pure delegation — no named exports, no business logic.

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

// The shim lives at  packages/server/src/api/orchestrator-mcp.ts
const SHIM_SRC_DIR = path.resolve(__dirname, "../../src/api");
const SHIM_SRC_FILE = path.join(SHIM_SRC_DIR, "orchestrator-mcp.ts");

// The shim resolves its target via require.resolve("@zana-ai/mcp/dist/src/
// mcp-server.js"), which is layout-independent. The built entry must exist —
// this is the file a spawned worker's MCP actually boots. Regression guard for
// the "Cannot find module" crash that made daemon-dispatched zana_* tools
// unavailable inside spawned agents.
const DELEGATED_PATH_JS = require.resolve("@zana-ai/mcp/dist/src/mcp-server.js");

// ---------------------------------------------------------------------------

describe("orchestrator-mcp shim — delegation target", () => {
  it("the built mcp-server entry the shim requires exists", () => {
    expect(fs.existsSync(DELEGATED_PATH_JS)).toBe(true);
  });

  it("resolves to packages/mcp/dist/src/mcp-server — not some other directory", () => {
    // Guard against silent breakage if the mcp package is moved.
    expect(DELEGATED_PATH_JS).toMatch(/packages[\\/]mcp[\\/]dist[\\/]src[\\/]mcp-server\.js$/);
  });
});

// ---------------------------------------------------------------------------

describe("orchestrator-mcp shim — source shape", () => {
  let content: string;

  it("the shim source file is readable", () => {
    content = fs.readFileSync(SHIM_SRC_FILE, "utf8");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains a require() call (proves delegation is present)", () => {
    content ??= fs.readFileSync(SHIM_SRC_FILE, "utf8");
    expect(content).toContain("require(");
  });

  it("delegates to the mcp-server entry (require.resolve of the mcp package)", () => {
    content ??= fs.readFileSync(SHIM_SRC_FILE, "utf8");
    // The shim must reference the @zana-ai/mcp mcp-server entry.
    expect(content).toMatch(/@zana-ai\/mcp[^"']*mcp-server/);
  });

  it("does not declare named exports (pure side-effect module)", () => {
    content ??= fs.readFileSync(SHIM_SRC_FILE, "utf8");
    // No top-level export keyword other than comments.
    expect(content).not.toMatch(/^export\s+(function|class|const|let|var|type|interface)/m);
  });
});
