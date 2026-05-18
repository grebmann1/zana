#!/bin/bash
# Zana hook relay (broadcast mode).
#
# Claude Code hooks invoke this script with the event's JSON payload on
# stdin. We forward that payload to ALL running daemon instances discovered
# from the registry at ~/.zana/daemons/*.json (legacy ~/.zana/hives also scanned).

set -u

INPUT=$(cat)
TERMINAL_ID="${ZANA_TERMINAL_ID:-}"

if [ -n "$TERMINAL_ID" ]; then
  # Inject zana_terminal_id safely via jq — handles arbitrary characters
  # (slash, hash, pipe, backslash, quotes) without shell-escaping pitfalls.
  if command -v jq >/dev/null 2>&1; then
    INJECTED=$(printf '%s' "$INPUT" | jq -c --arg tid "$TERMINAL_ID" '. + {zana_terminal_id: $tid}' 2>/dev/null)
    if [ -n "$INJECTED" ]; then
      INPUT="$INJECTED"
    fi
  fi
fi

# Cap fan-out: even if the registry has stale daemon files, never fork-bomb.
MAX_DAEMONS=10
DAEMON_COUNT=0
TOTAL_FOUND=0
CAPPED=0

for ZANA_DIR in "$HOME/.zana/daemons" "$HOME/.zana/hives"; do
  [ -d "$ZANA_DIR" ] || continue
  for f in "$ZANA_DIR"/*.json; do
    [ -f "$f" ] || continue
    TOTAL_FOUND=$((TOTAL_FOUND + 1))
    if [ "$DAEMON_COUNT" -ge "$MAX_DAEMONS" ]; then
      CAPPED=1
      continue
    fi
    PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "$f" | head -1 | grep -o '[0-9]*$')
    [ -n "$PORT" ] || continue
    (
      curl -sf --max-time 0.4 -X POST "http://127.0.0.1:$PORT/hook" \
        -H "Content-Type: application/json" \
        --data-binary "$INPUT" \
        >/dev/null 2>&1
    ) &
    DAEMON_COUNT=$((DAEMON_COUNT + 1))
  done
done

if [ "$CAPPED" = "1" ]; then
  echo "[zana-hook-wrapper] WARNING: $TOTAL_FOUND daemons in registry, capping fan-out at $MAX_DAEMONS. Run 'zana stop --all' to clean up." >&2
fi

exit 0
