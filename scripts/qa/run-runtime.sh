#!/usr/bin/env bash
# Live runtime smoke — exercises the Claude Code spawn path end-to-end.
#
# R1: ZANA_RUNTIME=spawn (default) — oneshot returns PONG
# R2: real-claude deliberation snap (scripts/diagnostics/run-real-deliberation-snap.js)
#
# Both use the local `claude` CLI for auth. No ANTHROPIC_API_KEY required —
# whatever auth `claude` itself uses is the auth Zana inherits.
#
# Preconditions:
#   `claude` CLI on PATH and logged in (run `claude` once to verify)
#   Repo built (npm run build:runtime)

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

RESULTS="$REPO/scripts/qa/results/runtime.txt"
mkdir -p "$(dirname "$RESULTS")"
: > "$RESULTS"

PASS=0; FAIL=0; SKIP=0
record() {  # record <id> <PASS|FAIL|SKIP> <message>
  printf "%-4s %-4s  %s\n" "$1" "$2" "$3" | tee -a "$RESULTS"
  case "$2" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    SKIP) SKIP=$((SKIP+1)) ;;
  esac
}

# -- precondition gate ------------------------------------------------------

if ! command -v claude >/dev/null 2>&1; then
  record R1 SKIP "claude CLI not on PATH — install/login Claude Code first"
  record R2 SKIP "claude CLI not on PATH"
else

  # -- R1: claude-spawn oneshot ---------------------------------------------

  R1_OUT=$(ZANA_RUNTIME=spawn node -e '
    const path = require("path");
    const REPO = process.cwd();
    const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
    require(path.join(REPO, "packages/work/dist/src/index.js"));
    try { core.project.workspaceContext.init(REPO); } catch {}
    (async () => {
      const profile = core.agents.profileStore.getProfile("researcher");
      if (!profile) { console.error("CRASH: researcher profile not found"); process.exit(1); }
      const { spawnOneShot } = require(path.join(REPO, "packages/core/dist/src/agents/spawner.js"));
      const r = await spawnOneShot(profile, "Reply with the single word: PONG", { cwd: REPO, timeout: 90000 });
      console.log("R1_OUTPUT:", JSON.stringify({ output: (r.output || "").slice(0, 200), exitCode: r.exitCode }));
      if (/PONG/i.test(r.output || "")) { console.log("PASS"); process.exit(0); }
      console.error("FAIL: PONG not in output"); process.exit(1);
    })().catch((err) => { console.error("CRASH:", err && err.message); process.exit(1); });
  ' 2>&1)
  R1_EXIT=$?
  if [ "$R1_EXIT" = "0" ] && echo "$R1_OUT" | grep -q "^PASS$"; then
    record R1 PASS "claude-spawn oneshot returned PONG ($(echo "$R1_OUT" | grep R1_OUTPUT | head -1))"
  else
    record R1 FAIL "claude-spawn oneshot did not return PONG | exit=$R1_EXIT | $(echo "$R1_OUT" | tail -3 | tr '\n' ' | ')"
  fi

  # -- R2: real-claude deliberation snap -----------------------------------

  if [ -f "$REPO/scripts/diagnostics/run-real-deliberation-snap.js" ]; then
    R2_OUT=$(ZANA_RUNTIME=spawn \
      node "$REPO/scripts/diagnostics/run-real-deliberation-snap.js" 2>&1)
    R2_EXIT=$?
    # Snap script signals success via exit code 0 + a `[done]` summary line.
    # The voter rationale and tool-call budget line are also evidence the
    # full Claude path executed.
    if [ "$R2_EXIT" = "0" ] && echo "$R2_OUT" | grep -qE "^\[done\]" && echo "$R2_OUT" | grep -q "tool calls:"; then
      DONE_LINE=$(echo "$R2_OUT" | grep -E "^\[done\]" | head -1)
      record R2 PASS "deliberation snap: real Claude voter ran ($DONE_LINE)"
    else
      record R2 FAIL "deliberation snap failed | exit=$R2_EXIT | $(echo "$R2_OUT" | tail -3 | tr '\n' ' | ')"
    fi
  else
    record R2 SKIP "scripts/diagnostics/run-real-deliberation-snap.js not present"
  fi
fi

# -- summary -----------------------------------------------------------------

TOTAL=$((PASS + FAIL + SKIP))
{
  echo
  echo "=== SUMMARY ==="
  echo "PASS: $PASS"
  echo "FAIL: $FAIL"
  echo "SKIP: $SKIP"
  echo "TOTAL: $TOTAL"
} | tee -a "$RESULTS"

[ "$FAIL" -eq 0 ] || exit 1
