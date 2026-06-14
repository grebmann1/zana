// buildClaudeArgs — mcpConfig handling (writeTempMcpConfig branch).
//
// When a profile carries an `mcpConfig`, buildClaudeArgs must:
//   - write a resolved config file to a temp dir and emit `--mcp-config <path>`,
//   - add `--strict-mcp-config` only when `strictMcpConfig` is set,
//   - replace the `__ORCHESTRATOR_MCP_PATH__` placeholder in server args with a
//     concrete absolute path, and inject the orchestrator bridge env (ZANA_PORT).
//
// These exercise the writeTempMcpConfig path, which the other spawner test
// files do not touch. The test is deterministic: it pins ZANA_WORKER_BIN,
// reads back the file the function wrote, and only asserts on structure.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("buildClaudeArgs — mcpConfig", () => {
  it("emits --mcp-config pointing at a written JSON file and resolves the orchestrator placeholder", () => {
    const profile = {
      id: "mcp-config-test-profile",
      mcpConfig: {
        zana: {
          command: "node",
          args: ["__ORCHESTRATOR_MCP_PATH__"],
        },
      },
    };

    const args = buildClaudeArgs(profile, { terminalId: "term-1", name: "worker-a" });

    const configPath = flagValue(args, "--mcp-config");
    expect(configPath).toBeDefined();
    expect(configPath!.endsWith(".json")).toBe(true);
    expect(fs.existsSync(configPath!)).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath!, "utf8"));
    const server = written.mcpServers.zana;
    // Placeholder must have been substituted with a concrete path.
    expect(server.args).not.toContain("__ORCHESTRATOR_MCP_PATH__");
    expect(server.args[0]).toContain("orchestrator-mcp.js");
    // Orchestrator bridge env is injected for servers using the bridge.
    expect(server.env.ZANA_PORT).toBeDefined();
    expect(server.env.ZANA_TERMINAL_ID).toBe("term-1");
    expect(server.env.ZANA_AGENT_NAME).toBe("worker-a");
  });

  it("omits --strict-mcp-config unless strictMcpConfig is set, and includes it when set", () => {
    const base = {
      id: "mcp-config-strict-profile",
      mcpConfig: { zana: { command: "node", args: [] } },
    };

    const without = buildClaudeArgs({ ...base });
    expect(without).not.toContain("--strict-mcp-config");

    const withStrict = buildClaudeArgs({ ...base, strictMcpConfig: true });
    expect(withStrict).toContain("--strict-mcp-config");
  });

  it("does not emit --mcp-config when the profile has no mcpConfig", () => {
    const args = buildClaudeArgs({ id: "no-mcp-profile" });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });
});
