---
name: zana:version
description: Show installed Zana version, latest published version, and whether an update is available.
allowed-tools: Bash
---

# /zana:version

Compare the locally installed `@zana-ai/mcp` version against the latest
published version on npm. No arguments. Read-only.

## Workflow

Run this single Bash block and print its output verbatim:

```bash
# Resolve the path Claude Code actually loads — the source of truth is the
# `command` + `args` in ~/.claude/settings.json mcpServers.zana, not whatever
# npm/npx happens to have cached.
ACTIVE_PATH=$(node -e '
  try {
    const s = require(require("os").homedir() + "/.claude/settings.json");
    const m = s.mcpServers && s.mcpServers.zana;
    if (m && Array.isArray(m.args)) console.log(m.args.find(a => a.endsWith(".js")) || "");
  } catch {}
' 2>/dev/null)

ACTIVE_VERSION=""
if [ -n "$ACTIVE_PATH" ] && [ -f "$ACTIVE_PATH" ]; then
  PKG_DIR=$(node -e "const p='$ACTIVE_PATH'; const path=require('path'); let d=path.dirname(p); while(d!=='/' && !require('fs').existsSync(path.join(d,'package.json'))) d=path.dirname(d); console.log(d)")
  ACTIVE_VERSION=$(node -e "console.log(require('$PKG_DIR/package.json').version)" 2>/dev/null)
fi

GLOBAL_VERSION=$(npm ls -g @zana-ai/mcp --depth=0 2>/dev/null | awk -F@ '/@zana-ai\/mcp/ {print $NF; exit}')
LATEST=$(npm view @zana-ai/mcp version 2>/dev/null)

echo "active (loaded by Claude Code): ${ACTIVE_VERSION:-(none — settings.json has no zana mcp entry)}"
[ -n "$ACTIVE_PATH" ] && echo "  path: $ACTIVE_PATH"
echo "global npm install:             ${GLOBAL_VERSION:-(none)}"
echo "latest on npm:                  ${LATEST:-(registry unreachable)}"

if [ -n "$ACTIVE_VERSION" ] && [ -n "$LATEST" ] && [ "$ACTIVE_VERSION" != "$LATEST" ]; then
  echo ""
  echo "→ update available. Run /zana:update to upgrade."
elif [ -n "$ACTIVE_VERSION" ] && [ "$ACTIVE_VERSION" = "$LATEST" ]; then
  echo ""
  echo "✓ up to date"
fi

if [ -n "$GLOBAL_VERSION" ] && [ -n "$ACTIVE_VERSION" ] && [ "$GLOBAL_VERSION" != "$ACTIVE_VERSION" ]; then
  echo ""
  echo "⚠  the global npm install ($GLOBAL_VERSION) does not match the version Claude Code is loading ($ACTIVE_VERSION)."
  echo "   Claude Code follows the path in ~/.claude/settings.json — re-run /zana:update to point it at the global install."
fi
```

## Rules

- Read-only. Never run `npm install` here — that's `/zana:update`.
- If the registry is unreachable, say so plainly; do not retry.
- If the user runs Zana from source (no global install), the bash will print
  `(not found via npm — may be running from source)`. In that case suggest
  `cd <repo> && git pull && npm run build:runtime` instead of `/zana:update`.
