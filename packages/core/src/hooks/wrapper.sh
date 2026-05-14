#!/bin/bash
# Zana hook relay (broadcast mode).
#
# Claude Code hooks invoke this script with the event's JSON payload on
# stdin. We forward that payload to ALL running Hive instances discovered
# from the registry at ~/.zana/hives/*.json.

set -u

INPUT=$(cat)
TERMINAL_ID="${ZANA_TERMINAL_ID:-}"

if [ -n "$TERMINAL_ID" ]; then
  INPUT=$(printf '%s' "$INPUT" | sed "s#^{#{\"hive_terminal_id\":\"$TERMINAL_ID\",#")
fi

ZANA_DIR="$HOME/.zana/hives"

if [ -d "$ZANA_DIR" ]; then
  for f in "$ZANA_DIR"/*.json; do
    [ -f "$f" ] || continue
    PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "$f" | head -1 | grep -o '[0-9]*$')
    [ -n "$PORT" ] || continue
    (
      curl -sf --max-time 0.4 -X POST "http://127.0.0.1:$PORT/hook" \
        -H "Content-Type: application/json" \
        --data-binary "$INPUT" \
        >/dev/null 2>&1
    ) &
  done
fi

exit 0
