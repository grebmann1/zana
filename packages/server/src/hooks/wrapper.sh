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
  INPUT=$(printf '%s' "$INPUT" | sed "s#^{#{\"zana_terminal_id\":\"$TERMINAL_ID\",#")
fi

for ZANA_DIR in "$HOME/.zana/daemons" "$HOME/.zana/hives"; do
  [ -d "$ZANA_DIR" ] || continue
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
done

exit 0
