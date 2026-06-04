// Shared types for per-domain MCP tool registrations.
//
// Every domain under registrations/ exports a TOOLS array (JSON-Schema
// metadata for `tools/list`) plus a HANDLERS map (name → async function).
// The bootstrap in mcp-server.ts wires both together and routes
// `tools/call` to the matching handler.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

// Context passed to every domain handler. Lazy getters keep the cross-package
// require-cycle from biting at module-load time — see CLAUDE.md "Repo layout"
// for why core ↔ work ↔ extras still live in one cycle.
export interface ToolContext {
  /** Forwards an action to `agentManager.handleOrchestratorCommand`. */
  callCore(action: string, params?: Record<string, unknown>): Promise<any> | any;
  /** ID of the agent that issued the tool call (parent terminal). May be null. */
  callerAgentId: string | null;
  /** Lazy access to the booted local daemon. Throws if called pre-bootstrap. */
  getDaemon(): any;
}

export type ToolHandler = (args: any, ctx: ToolContext) => Promise<any> | any;

export interface ToolDomain {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}
