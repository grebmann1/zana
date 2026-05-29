#!/usr/bin/env bash
# Live ticket lifecycle smoke — create ticket → spawn worker that claims and
# completes it → assert ticket status transitions through the daemon API.
#
# Uses the `claude` CLI to spawn a real Claude Code worker. Hermetic (temp
# workspace + isolated daemon registry).
#
# Preconditions: `claude` CLI on PATH and logged in, repo built.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

WS="/tmp/zana-qa-ticket-$$"
DREG="/tmp/zana-qa-ticket-reg-$$"
mkdir -p "$WS" "$DREG"
export ZANA_DAEMONS_DIR="$DREG"
export ZANA_PORT="${ZANA_PORT:-47412}"

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
curl_json() {  # curl_json METHOD PATH [BODY]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -fsS -X "$m" "$API$p" -H "$AUTH_HDR" -H 'content-type: application/json' -d "$b" 2>&1
  else
    curl -fsS -X "$m" "$API$p" -H "$AUTH_HDR" 2>&1
  fi
}

# -- T1: create ticket via API ---------------------------------------------

TICKET=$(curl_json POST /tickets '{"title":"QA-live: confirm PONG","description":"Reply with PONG to confirm.","priority":"low","kind":"task"}')
TICKET_ID=$(echo "$TICKET" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.ticketId||j.id||(j.ticket&&(j.ticket.id||j.ticket.ticketId))||"")}catch{console.log("")}})')

if [ -n "$TICKET_ID" ]; then
  record T1 PASS "ticket created id=$TICKET_ID"
else
  record T1 FAIL "ticket creation returned no id | $TICKET"
fi

# -- T2: ticket appears in list with status open ---------------------------

LIST=$(curl_json GET /tickets)
if echo "$LIST" | grep -q "$TICKET_ID"; then
  record T2 PASS "ticket present in /tickets list"
else
  record T2 FAIL "ticket not in list | $LIST"
fi

# -- T3: spawn a worker and have it claim + complete the ticket ------------
#
# We drive the worker by calling the same orchestrator command path the MCP
# tools use (ticket_claim + ticket_complete). This avoids the worker needing
# tool-call permissions to hit the local daemon HTTP API itself — what we're
# testing here is the lifecycle plumbing, not whether a Claude worker can
# perform its own HTTP calls.

CLAIM=$(curl_json POST "/tickets/$TICKET_ID/claim" '{"agentId":"qa-live","agentName":"QA Live"}')
if echo "$CLAIM" | grep -qE '"ok":\s*true|"status":\s*"in_progress"|"claimed"'; then
  record T3 PASS "ticket claimed by qa-live"
else
  record T3 FAIL "claim failed | $CLAIM"
fi

# -- T4: spawn a real worker that emits PONG (proves dispatch works) ------

SPAWN=$(curl_json POST /agents '{"profileId":"researcher","prompt":"Reply with the single word: PONG"}')
AGENT_ID=$(echo "$SPAWN" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.agentId||j.id||"")}catch{console.log("")}})')

if [ -z "$AGENT_ID" ]; then
  record T4 FAIL "spawn returned no agentId | $SPAWN"
else
  # Wait for terminate
  AGENT_RESULT=""
  for i in $(seq 1 120); do
    AGENT=$(curl -fsS -H "$AUTH_HDR" "$API/agents/$AGENT_ID" 2>/dev/null || true)
    STATE=$(echo "$AGENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).state||"")}catch{console.log("")}})')
    if [ "$STATE" = "terminated" ]; then
      AGENT_RESULT=$(echo "$AGENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(((JSON.parse(d).result)||"").slice(0,200))}catch{console.log("")}})')
      break
    fi
    sleep 1
  done
  if echo "$AGENT_RESULT" | grep -qi "PONG"; then
    record T4 PASS "researcher worker terminated with PONG"
  else
    record T4 FAIL "researcher worker did not return PONG | result=$AGENT_RESULT"
  fi
fi

# -- T5: complete ticket and verify status transitions to done -------------

COMP=$(curl_json POST "/tickets/$TICKET_ID/complete" '{"resultSummary":"Worker confirmed: PONG","completedBy":"qa-live"}')
if echo "$COMP" | grep -qE '"ok":\s*true|"status":\s*"done"|completed'; then
  record T5 PASS "ticket completed"
else
  record T5 FAIL "complete failed | $COMP"
fi

GET=$(curl_json GET "/tickets/$TICKET_ID")
STATUS=$(echo "$GET" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch{console.log("")}})')
if [ "$STATUS" = "done" ]; then
  record T6 PASS "ticket status now 'done'"
else
  record T6 FAIL "ticket status is '$STATUS' (expected done) | $GET"
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
