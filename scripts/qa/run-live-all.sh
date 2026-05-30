#!/usr/bin/env bash
# Run all live-Claude-Code smoke scripts in sequence.
#
# Each script spawns the local `claude` CLI as the worker, so whatever auth
# `claude` itself uses is the auth Zana inherits.
#
# Preconditions: `claude` CLI on PATH and logged in, repo built.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not on PATH — refusing to run."
  echo "Install Claude Code and log in first (run \`claude\` once interactively)."
  exit 1
fi

declare -a SUITES=(
  "scripts/qa/run-runtime.sh"
  "scripts/qa/run-scheduler-agent-live.sh"
  "scripts/qa/run-ticket-live.sh"
  "scripts/qa/run-autopilot-live.sh"
  "scripts/qa/run-judge-live.sh"
  "scripts/qa/run-commands-live.sh"
)

OVERALL_FAIL=0
for s in "${SUITES[@]}"; do
  echo
  echo "############################################################"
  echo "# $s"
  echo "############################################################"
  if bash "$s"; then
    echo "[ok] $s"
  else
    echo "[FAIL] $s"
    OVERALL_FAIL=$((OVERALL_FAIL+1))
  fi
  # Drain stale daemons + give the kernel time to reclaim FDs/ports before
  # the next suite, otherwise back-to-back runs hit ECONNREFUSED on port
  # rebind or "too many open files" on heavy spawn loops.
  node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
  pkill -f 'daemon.js.*--workspace=/tmp/zana-qa-' >/dev/null 2>&1 || true
  sleep 5
done

echo
echo "############################################################"
echo "# OVERALL"
echo "############################################################"
if [ "$OVERALL_FAIL" -eq 0 ]; then
  echo "All ${#SUITES[@]} suites passed."
else
  echo "$OVERALL_FAIL of ${#SUITES[@]} suites failed."
  exit 1
fi
