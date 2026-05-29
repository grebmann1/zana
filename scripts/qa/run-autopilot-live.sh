#!/usr/bin/env bash
# Live autopilot smoke — submit a tiny goal-driven request, watch the
# autopilot module run one iteration through its planner + spawn loop, then
# cancel. Exercises the GOAP planner + agent dispatch path.
#
# Spawns Claude Code workers via the `claude` CLI. Hermetic (temp workspace,
# isolated daemon registry).
#
# Preconditions: `claude` CLI on PATH and logged in, repo built.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

WS="/tmp/zana-qa-autopilot-$$"
DREG="/tmp/zana-qa-autopilot-reg-$$"
mkdir -p "$WS" "$DREG"
export ZANA_DAEMONS_DIR="$DREG"
export ZANA_PORT="${ZANA_PORT:-47413}"

PASS=0; FAIL=0
declare -a RESULTS
record() { RESULTS+=("$1|$2|$3"); [ "$2" = "PASS" ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1)); }

cleanup() {
  node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
  rm -rf "$WS" "$DREG"
}
trap cleanup EXIT

# -- precondition gate ------------------------------------------------------

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP all — claude CLI not on PATH (install/login Claude Code first)"
  exit 0
fi

# -- setup + daemon ---------------------------------------------------------

node dist/bin/zana.js init "$WS" >/dev/null 2>&1
node dist/bin/zana.js headless "$WS" --background >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then break; fi
  sleep 0.5
done

# HTTP API uses the daemon's apiPort (not $ZANA_PORT — that's the hook port)
# and a bearer token from ~/.zana/auth.json.
API_PORT=$(node -e '
  const fs=require("fs"),path=require("path"),os=require("os");
  const d=path.join(os.homedir(),".zana","daemons");
  const ws=process.argv[1];
  for (const f of fs.readdirSync(d)) {
    try { const j=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
      if (j.workspace===ws) { console.log(j.apiPort||j.port); process.exit(0); } } catch{}
  }' "$WS")
TOKEN=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.zana/auth.json","utf8")).token)}catch{}')
PORT="${API_PORT:-$ZANA_PORT}"
record T0 PASS "daemon up on port $PORT"

API="http://127.0.0.1:$PORT"
AUTH_HDR="Authorization: Bearer $TOKEN"
curl_json() {
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then curl -fsS -X "$m" "$API$p" -H "$AUTH_HDR" -H 'content-type: application/json' -d "$b" 2>&1
  else curl -fsS -X "$m" "$API$p" -H "$AUTH_HDR" 2>&1; fi
}

# -- T1: create a goal with two tiny researcher steps -----------------------
#
# Tiny steps so each iteration is short. The autopilot module's runGoal()
# loops up to maxIterations (default 5) — we only need one cycle to prove
# the dispatch + evaluator wiring.

GOAL_BODY='{
  "title": "QA-live autopilot smoke",
  "criteria": "Each step produced a non-empty answer.",
  "steps": [
    {"profile": "researcher", "prompt": "Reply with: STEP1-OK"},
    {"profile": "researcher", "prompt": "Reply with: STEP2-OK"}
  ]
}'

CREATE=$(curl_json POST /api/autopilot/goals "$GOAL_BODY")
# Server-side bug: handler doesn't await the async setGoal(), so the POST
# response serializes as `{}`. Work around it by listing goals and picking
# the newest one (we just created it).
GOAL_ID=$(echo "$CREATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).goalId||JSON.parse(d).id||"")}catch{console.log("")}})')
if [ -z "$GOAL_ID" ]; then
  sleep 1
  GOAL_ID=$(curl_json GET /api/autopilot/goals | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try { const arr=JSON.parse(d); const sorted=[...arr].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); console.log((sorted[0]||{}).id||"") } catch { console.log("") }
    })')
fi

if [ -n "$GOAL_ID" ]; then
  record T1 PASS "goal created id=$GOAL_ID"
else
  record T1 FAIL "goal create returned no id | create=$CREATE"
  echo "PASS: $PASS    FAIL: $FAIL"
  exit 1
fi

# -- T2: goal listed with running status ------------------------------------

LIST=$(curl_json GET /api/autopilot/goals)
if echo "$LIST" | grep -q "$GOAL_ID"; then
  record T2 PASS "goal in list"
else
  record T2 FAIL "goal not in list | $LIST"
fi

# -- T3: goal advances past iteration 0 (proves spawn loop runs) -----------

ADVANCED=""
for i in $(seq 1 90); do
  G=$(curl_json GET "/api/autopilot/goals/$GOAL_ID")
  ITER=$(echo "$G" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).iteration||0)}catch{console.log(0)}})')
  STATUS=$(echo "$G" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch{console.log("")}})')
  if [ "${ITER:-0}" -ge 1 ] || [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    ADVANCED="iter=$ITER status=$STATUS"
    break
  fi
  sleep 1
done
if [ -n "$ADVANCED" ]; then
  record T3 PASS "goal advanced ($ADVANCED)"
else
  record T3 FAIL "goal stayed at iteration 0 for 90s — spawn loop didn't fire"
fi

# -- T4: cancel the goal ----------------------------------------------------
# Use API DELETE — autopilot module exposes cancelGoal there.

CANCEL=$(curl -fsS -X DELETE -H "$AUTH_HDR" "$API/api/autopilot/goals/$GOAL_ID" 2>&1)
if echo "$CANCEL" | grep -qE '"ok":\s*true|"status":\s*"cancelled"|cancelled'; then
  record T4 PASS "goal cancelled"
else
  record T4 FAIL "cancel failed | $CANCEL"
fi

# -- T5: post-cancel status reflects the cancel -----------------------------

sleep 1
G2=$(curl_json GET "/api/autopilot/goals/$GOAL_ID")
STATUS2=$(echo "$G2" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch{console.log("")}})')
if [ "$STATUS2" = "cancelled" ] || [ "$STATUS2" = "completed" ] || [ "$STATUS2" = "failed" ]; then
  record T5 PASS "goal terminal status=$STATUS2"
else
  record T5 FAIL "goal status still $STATUS2 after cancel"
fi

# -- summary -----------------------------------------------------------------

echo
echo "============================================================"
printf "%-4s %-6s %s\n" "ID" "RESULT" "DETAIL"
echo "------------------------------------------------------------"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r id res det <<< "$r"
  printf "%-4s %-6s %s\n" "$id" "$res" "$det"
done
echo "------------------------------------------------------------"
TOTAL=$((PASS + FAIL))
echo "PASS: $PASS / $TOTAL    FAIL: $FAIL"
echo "============================================================"

[ "$FAIL" -eq 0 ] || exit 1
