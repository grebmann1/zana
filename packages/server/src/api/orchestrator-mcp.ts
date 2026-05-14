// Shim — delegates to the actual MCP server in packages/mcp/
// Must be run from the project root so @zana/core resolves from root node_modules.
import * as path from "path";
require(path.resolve(__dirname, "../../../mcp/src/mcp-server.js"));
