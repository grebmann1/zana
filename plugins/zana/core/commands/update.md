---
name: zana:update
description: Upgrade the globally installed @zana-ai/mcp (and all sibling packages) to the latest version on npm.
allowed-tools: Bash
---

# /zana:update

Upgrade Zana to the latest published version on npm. No arguments.

## Workflow

1. **Announce** in one line: `Upgrading @zana-ai/mcp to the latest version on npm — this may take 30s.`

2. Run this single Bash block:

   ```bash
   BEFORE=$(npm ls -g @zana-ai/mcp --depth=0 2>/dev/null | awk -F@ '/@zana-ai\/mcp/ {print $NF; exit}')
   LATEST=$(npm view @zana-ai/mcp version 2>/dev/null)

   if [ -z "$BEFORE" ]; then
     echo "@zana-ai/mcp is not installed globally via npm."
     echo "If you run Zana from source, update with: cd <repo> && git pull && npm run build:runtime"
     exit 0
   fi

   if [ "$BEFORE" = "$LATEST" ]; then
     echo "Already on $BEFORE — nothing to do."
     exit 0
   fi

   echo "upgrading: $BEFORE → $LATEST"
   npm install -g @zana-ai/mcp@latest 2>&1 | tail -5

   AFTER=$(npm ls -g @zana-ai/mcp --depth=0 2>/dev/null | awk -F@ '/@zana-ai\/mcp/ {print $NF; exit}')
   echo ""
   echo "installed: $AFTER"
   ```

3. After the install finishes, print this reminder VERBATIM:

   > Restart any running daemons (`zana stop && zana start`) and reopen any
   > Claude Code sessions for the new MCP server to load. The path in
   > `~/.claude/settings.json` already points at the upgraded package — no
   > settings edit needed.

## Rules

- Mutating: actually runs `npm install -g`. Always announce before running.
- Never use `--force` or `--legacy-peer-deps` flags.
- If the npm install fails (non-zero exit, EACCES, network error), surface the
  last 5 lines of output and stop — do not retry.
- The install pulls the six sibling packages transitively; do not install them
  one by one.
- Do NOT run `npm update` — it does not respect the `latest` dist-tag and can
  leave you on a stale minor.
