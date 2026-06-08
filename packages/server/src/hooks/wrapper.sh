#!/bin/bash
# Zana hook relay (broadcast mode + daemonless fallback).
#
# Claude Code hooks invoke this script with the event's JSON payload on
# stdin. We:
#   1. Forward to ALL running daemon instances (registry at
#      ~/.zana/daemons/*.json; legacy ~/.zana/hives also scanned).
#   2. ALWAYS append the payload to a daemonless fallback file at
#      ~/.zana/events/wrapper-fallback.ndjson so events are observable
#      even when no daemon is running. Without this, the user sees
#      empty session events.ndjson files (the daemon creates them on
#      init but never appends if no daemon is alive when hooks fire).
#
# Fallback file is rotated by `wc -l` heuristic at 100k lines (rough
# 50MB ceiling for typical payload sizes); older content goes to
# wrapper-fallback.ndjson.<ts> and is pruned beyond 5 rolled files.

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

# Daemonless fallback: append the timestamped payload so observability
# survives the no-daemon-running case (which is the common case during
# native Claude Code chat sessions). Use a single global file keyed by
# zana_terminal_id (already injected above) so a future `zana ingest`
# can drain it into the appropriate session record.
FALLBACK_DIR="$HOME/.zana/events"
FALLBACK_FILE="$FALLBACK_DIR/wrapper-fallback.ndjson"
mkdir -p "$FALLBACK_DIR" 2>/dev/null
if [ -d "$FALLBACK_DIR" ]; then
  TS_MS=$(($(date +%s%N 2>/dev/null || echo $(date +%s)000000000) / 1000000))
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -c --argjson ts "$TS_MS" '. + {ts: $ts}' >> "$FALLBACK_FILE" 2>/dev/null
  else
    # Fallback when jq is unavailable: write raw payload + ts on a separate
    # line. Loses strict NDJSON-per-event but preserves the data.
    printf '%s\n' "$INPUT" >> "$FALLBACK_FILE" 2>/dev/null
  fi

  # Rough size-based rotation: when fallback exceeds 100k lines, rename to
  # a timestamped roll and start fresh. Keep at most 5 rolled files.
  if [ -f "$FALLBACK_FILE" ]; then
    LINES=$(wc -l < "$FALLBACK_FILE" 2>/dev/null || echo 0)
    if [ "$LINES" -gt 100000 ]; then
      mv "$FALLBACK_FILE" "$FALLBACK_FILE.$(date +%s)" 2>/dev/null
      ls -1t "$FALLBACK_DIR"/wrapper-fallback.ndjson.* 2>/dev/null | tail -n +6 | xargs -r rm -f 2>/dev/null
    fi
  fi
fi

exit 0
