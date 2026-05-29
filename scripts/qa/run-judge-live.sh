#!/usr/bin/env bash
# Live auto-judge smoke — exercises the post-loop adjudication path with a
# real Claude judge agent. Translates the END-TO-END scenarios from
# packages/mcp/test/tools/deliberate-judge.test.ts into bash that drives the
# real deliberateHandler (no spawn mocks).
#
# J1 — cap_exhausted + escalationStrategy="judge" → SETTLED, verdictSource=judge,
#      override.humanId starts with "judge:", _outcome="judged"
# J2 — riskTag="high" + escalationStrategy="judge" → still ESCALATED,
#      verdictSource undefined, _outcome != "judged" (high-risk bypass)
# J3 — escalationStrategy="hybrid" on low-risk deadlock → judge runs, SETTLED,
#      verdictSource=judge
#
# Cost note: each scenario spawns 3 voter agents (1 round) and J1/J3 add a
# judge agent on top. Roughly 8 agent spawns of mixed sonnet/opus profiles per
# run. Pick the question to be a tiny preference call — minimal context,
# minimal tool use — to keep wall-clock + spend bounded.
#
# Hermetic: each scenario gets its own tmp workspace; no daemon (we drive
# deliberateHandler directly, like run-runtime.sh's R2 case).
#
# Preconditions: `claude` CLI on PATH and logged in, repo built.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

RESULTS="$REPO/scripts/qa/results/judge.txt"
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
  record J1 SKIP "claude CLI not on PATH — install/login Claude Code first"
  record J2 SKIP "claude CLI not on PATH"
  record J3 SKIP "claude CLI not on PATH"

  TOTAL=$((PASS + FAIL + SKIP))
  {
    echo
    echo "=== SUMMARY ==="
    echo "PASS: $PASS"
    echo "FAIL: $FAIL"
    echo "SKIP: $SKIP"
    echo "TOTAL: $TOTAL"
  } | tee -a "$RESULTS"
  exit 0
fi

# -- shared inline node driver ----------------------------------------------
#
# Runs deliberateHandler({ wait: true, ... }) against a fresh tmp workspace
# and prints a single-line JSON report on stdout for the bash side to parse.
# Args: $1=workspace dir, $2=question, $3=riskTag (low|high), $4=strategy
#       (judge|hybrid|human), $5=rounds.
#
# Drains stale daemons up front (other suites may have left some running on
# this machine) — the brief says to do that, even though this script doesn't
# itself spawn a daemon.

run_scenario() {
  local WS="$1" QUESTION="$2" RISK="$3" STRATEGY="$4" ROUNDS="$5"
  node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
  mkdir -p "$WS"

  WS="$WS" QUESTION="$QUESTION" RISK="$RISK" STRATEGY="$STRATEGY" ROUNDS="$ROUNDS" \
  ZANA_RUNTIME=spawn \
  node -e '
    const path = require("path");
    const REPO = process.cwd();
    const WS = process.env.WS;
    const QUESTION = process.env.QUESTION;
    const RISK = process.env.RISK;
    const STRATEGY = process.env.STRATEGY;
    const ROUNDS = parseInt(process.env.ROUNDS, 10) || 1;

    const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
    require(path.join(REPO, "packages/work/dist/src/index.js"));
    try { core.project.workspaceContext.init(WS); } catch {}

    const { deliberateHandler } = require(
      path.join(REPO, "packages/mcp/dist/src/tools/deliberate.js"),
    );

    (async () => {
      const t0 = Date.now();
      const result = await deliberateHandler({
        wait: true,
        question: QUESTION,
        // 3-voter council, single round → if real voters split 2-1 the loop
        // hits cap_exhausted and lands ESCALATED.
        voters: ["architect", "security-reviewer", "researcher"],
        rounds: ROUNDS,
        riskTag: RISK,
        escalationStrategy: STRATEGY,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      // Single-line JSON for the bash side.
      console.log("RESULT_JSON:" + JSON.stringify({
        durationSec: Number(dt),
        state: result.state,
        verdict: result.verdict,
        verdictSource: result.verdictSource,
        escalationReason: result.escalationReason,
        _outcome: result._outcome,
        _judgeError: result._judgeError,
        overrideHumanId: result.override && result.override.humanId,
        overrideDecision: result.override && result.override.decision,
        currentRound: result.currentRound,
      }));
    })().catch((err) => {
      console.error("CRASH:", err && err.stack ? err.stack : err);
      process.exit(1);
    });
  ' 2>&1
}

# Tiny controversial preference question — designed to maximize split among
# architect / security-reviewer / researcher lenses. Subjective taste call
# with no objectively correct answer, so each lens reasons differently:
# architect leans toward consistency, security-reviewer toward conservatism,
# researcher toward whatever the prompt frames as "common practice."
QUESTION='Should small TypeScript helper modules (≤50 lines, single export, used in one place) live in their own dedicated file or be inlined into the consuming module? Vote APPROVE for "their own dedicated file", CHANGES for "inlined into the consuming module". This is a style preference call, not a correctness question.'

# -- J1: cap_exhausted + escalationStrategy="judge" → SETTLED + judge ------

WS_J1="/tmp/zana-qa-judge-j1-$$"
J1_OUT=$(run_scenario "$WS_J1" "$QUESTION" "low" "judge" 1)
J1_EXIT=$?
J1_JSON=$(echo "$J1_OUT" | grep "^RESULT_JSON:" | head -1 | sed 's/^RESULT_JSON://')

if [ "$J1_EXIT" = "0" ] && [ -n "$J1_JSON" ]; then
  STATE=$(echo "$J1_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).state||"")}catch{console.log("")}})')
  VSRC=$(echo "$J1_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).verdictSource||"")}catch{console.log("")}})')
  HID=$(echo "$J1_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).overrideHumanId||"")}catch{console.log("")}})')
  OUTCOME=$(echo "$J1_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d)._outcome||"")}catch{console.log("")}})')

  if [ "$STATE" = "SETTLED" ] && [ "$VSRC" = "judge" ] && [[ "$HID" == judge:* ]] && [ "$OUTCOME" = "judged" ]; then
    record J1 PASS "judge resolved escalation: state=$STATE verdictSource=$VSRC humanId=$HID"
  elif [ "$STATE" = "SETTLED" ] && [ "$VSRC" = "council" ]; then
    # Council reached consensus on its own — the judge path didn't trigger.
    # That doesn't disprove the feature, but the strict test assertion fails.
    record J1 FAIL "council settled without escalation (judge path not exercised) | state=$STATE verdictSource=$VSRC — re-run; preference-Q split is non-deterministic"
  else
    record J1 FAIL "unexpected outcome | json=$J1_JSON"
  fi
else
  record J1 FAIL "scenario crashed | exit=$J1_EXIT | $(echo "$J1_OUT" | tail -3 | tr '\n' ' | ')"
fi
rm -rf "$WS_J1" 2>/dev/null || true

# -- J2: riskTag="high" + escalationStrategy="judge" → still ESCALATED -----
#
# High-risk always routes to a human regardless of strategy (shouldJudge gate
# in judge.ts returns false on riskTag="high"). The deliberation must land
# ESCALATED with NO judge override applied.

WS_J2="/tmp/zana-qa-judge-j2-$$"
J2_OUT=$(run_scenario "$WS_J2" "$QUESTION" "high" "judge" 1)
J2_EXIT=$?
J2_JSON=$(echo "$J2_OUT" | grep "^RESULT_JSON:" | head -1 | sed 's/^RESULT_JSON://')

if [ "$J2_EXIT" = "0" ] && [ -n "$J2_JSON" ]; then
  STATE=$(echo "$J2_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).state||"")}catch{console.log("")}})')
  VSRC=$(echo "$J2_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.verdictSource===undefined?"undef":j.verdictSource||"")}catch{console.log("")}})')
  OUTCOME=$(echo "$J2_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j._outcome===undefined?"undef":j._outcome||"")}catch{console.log("")}})')

  if [ "$STATE" = "ESCALATED" ] && [ "$VSRC" = "undef" ] && [ "$OUTCOME" != "judged" ]; then
    record J2 PASS "high-risk bypassed judge: state=$STATE verdictSource=undefined outcome=$OUTCOME"
  elif [ "$STATE" = "SETTLED" ] && [ "$VSRC" = "council" ]; then
    record J2 FAIL "council settled without escalation (high-risk gate not exercised) | state=$STATE verdictSource=$VSRC — re-run; preference-Q split is non-deterministic"
  else
    record J2 FAIL "unexpected outcome | json=$J2_JSON"
  fi
else
  record J2 FAIL "scenario crashed | exit=$J2_EXIT | $(echo "$J2_OUT" | tail -3 | tr '\n' ' | ')"
fi
rm -rf "$WS_J2" 2>/dev/null || true

# -- J3: escalationStrategy="hybrid" on low-risk deadlock → judge runs ----
#
# "hybrid" is functionally equivalent to "judge" today (per shouldJudge), but
# it's a separate code path through the strategy resolver — exercise it.

WS_J3="/tmp/zana-qa-judge-j3-$$"
J3_OUT=$(run_scenario "$WS_J3" "$QUESTION" "low" "hybrid" 1)
J3_EXIT=$?
J3_JSON=$(echo "$J3_OUT" | grep "^RESULT_JSON:" | head -1 | sed 's/^RESULT_JSON://')

if [ "$J3_EXIT" = "0" ] && [ -n "$J3_JSON" ]; then
  STATE=$(echo "$J3_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).state||"")}catch{console.log("")}})')
  VSRC=$(echo "$J3_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).verdictSource||"")}catch{console.log("")}})')
  OUTCOME=$(echo "$J3_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d)._outcome||"")}catch{console.log("")}})')

  if [ "$STATE" = "SETTLED" ] && [ "$VSRC" = "judge" ] && [ "$OUTCOME" = "judged" ]; then
    record J3 PASS "hybrid strategy invoked judge: state=$STATE verdictSource=$VSRC"
  elif [ "$STATE" = "SETTLED" ] && [ "$VSRC" = "council" ]; then
    record J3 FAIL "council settled without escalation (judge path not exercised) | state=$STATE verdictSource=$VSRC — re-run; preference-Q split is non-deterministic"
  else
    record J3 FAIL "unexpected outcome | json=$J3_JSON"
  fi
else
  record J3 FAIL "scenario crashed | exit=$J3_EXIT | $(echo "$J3_OUT" | tail -3 | tr '\n' ' | ')"
fi
rm -rf "$WS_J3" 2>/dev/null || true

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
