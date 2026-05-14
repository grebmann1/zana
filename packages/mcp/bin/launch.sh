#!/usr/bin/env bash
# Auto-build + launch MCP server.
# Guarantees dist/ is fresh before starting stdio transport.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Rebuild if source is newer than dist
ENTRY="dist/src/mcp-server.js"
SRC="src/mcp-server.ts"

if [ ! -f "$ENTRY" ] || [ "$SRC" -nt "$ENTRY" ]; then
  npx tsc -p tsconfig.build.json 2>/dev/null
fi

exec node "$ENTRY" "$@"
