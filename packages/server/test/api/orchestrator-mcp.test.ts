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
// Its __dirname at runtime (source mode / ts-node) is that directory.
// Replicate the same path.resolve(__dirname, "../../../mcp/src/mcp-server.js")
// from here: test file is packages/server/test/api/ → walk up to src/api/.
const SHIM_SRC_DIR = path.resolve(__dirname, "../../src/api");
const SHIM_SRC_FILE = path.join(SHIM_SRC_DIR, "orchestrator-mcp.ts");

// Target path computed exactly as the shim does at runtime.
const DELEGATED_PATH_JS = path.resolve(SHIM_SRC_DIR, "../../../mcp/src/mcp-server.js");
const DELEGATED_PATH_TS = DELEGATED_PATH_JS.replace(/\.js$/, ".ts");

// ---------------------------------------------------------------------------

describe("orchestrator-mcp shim — delegation target", () => {
  it("the mcp-server entry the shim requires exists (as .ts source or .js build)", () => {
    const exists = fs.existsSync(DELEGATED_PATH_TS) || fs.existsSync(DELEGATED_PATH_JS);
    expect(exists).toBe(true);
  });

  it("resolves to packages/mcp/src/mcp-server — not some other directory", () => {
    // Guard against silent breakage if the mcp package is moved.
    expect(DELEGATED_PATH_TS).toMatch(/packages[\\/]mcp[\\/]src[\\/]mcp-server\.ts$/);
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

  it("delegates to the mcp-server path (require arg matches expected fragment)", () => {
    content ??= fs.readFileSync(SHIM_SRC_FILE, "utf8");
    // The shim must reference the mcp-server.js path component.
    expect(content).toMatch(/mcp[\\/\\"']*src[\\/\\"']*mcp-server/);
  });

  it("does not declare named exports (pure side-effect module)", () => {
    content ??= fs.readFileSync(SHIM_SRC_FILE, "utf8");
    // No top-level export keyword other than comments.
    expect(content).not.toMatch(/^export\s+(function|class|const|let|var|type|interface)/m);
  });
});
