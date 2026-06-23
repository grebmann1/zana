// Shim — delegates to the actual MCP server in packages/mcp/.
//
// A spawned worker's injected zana MCP config points its `command` at THIS
// file (resolveOrchestratorMcpPath in core/src/agents/spawner.ts). Running it
// must boot the real MCP server in packages/mcp.
//
// Resolution is package-relative via require.resolve("@zana-ai/mcp/...") rather
// than a hand-counted `../../../` walk. The old relative walk was authored for
// the SOURCE layout (packages/server/src/api) but runs from the BUILD layout
// (packages/server/dist/src/api), which has one extra directory level — so it
// resolved to packages/server/mcp/src/mcp-server.js (wrong package, wrong
// non-dist path) and threw "Cannot find module" the instant a worker tried to
// start its MCP. That made every daemon-dispatched zana_* tool unavailable
// inside a spawned agent. Package resolution is layout-independent and points
// at the built entry, so it works the same from src/ (ts-node) and dist/.
const mcpServerEntry = require.resolve("@zana-ai/mcp/dist/src/mcp-server.js");
require(mcpServerEntry);
