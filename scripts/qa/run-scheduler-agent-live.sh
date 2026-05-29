#!/usr/bin/env bash
# Live scheduler-agent smoke — schedule fires `spawn-agent` action, real
# Claude worker runs to completion, history records success.
#
# Hermetic: temp workspace, isolated daemon registry. Uses the `claude` CLI
# to dispatch the worker (whatever auth `claude` itself uses).
#
# Preconditions: `claude` CLI on PATH and logged in, repo built.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

WS="/tmp/zana-qa-sched-agent-$$"
DREG="/tmp/zana-qa-sched-agent-reg-$$"
mkdir -p "$WS" "$DREG"
export ZANA_DAEMONS_DIR="$DREG"
export ZANA_PORT="${ZANA_PORT:-47411}"

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

# -- setup -------------------------------------------------------------------

node dist/bin/zana.js init "$WS" >/dev/null 2>&1
mkdir -p "$WS/.zana/scheduler"

cat > "$WS/.zana/scheduler/qa-spawn.yml" <<'YAML'
id: qa-spawn
name: QA spawn-agent schedule
description: Fires a real Claude worker (researcher) on each tick.
enabled: true
schedule:
  every: 24h
action:
  type: spawn-agent
  profileId: researcher
  prompt: "Reply with the single word: PONG"
history:
  enabled: true
  retain: 5
YAML

# -- start daemon ------------------------------------------------------------

node dist/bin/zana.js headless "$WS" --background >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then break; fi
  sleep 0.5
done

# -- T1: schedule registered ------------------------------------------------

if node dist/bin/zana.js schedule list --workspace "$WS" 2>&1 | grep -q "qa-spawn"; then
  record T1 PASS "qa-spawn schedule registered"
else
  record T1 FAIL "qa-spawn not in list"
fi

# The HTTP API listens on `apiPort` from the daemon registry, NOT $ZANA_PORT
# (that's the hook server port). Read it back from ~/.zana/daemons/<id>.json
# along with the bearer token from ~/.zana/auth.json.
API_PORT=$(node -e '
  const fs=require("fs"),path=require("path"),os=require("os");
  const d=path.join(os.homedir(),".zana","daemons");
  const ws=process.argv[1];
  for (const f of fs.readdirSync(d)) {
    try { const j=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
      if (j.workspace===ws) { console.log(j.apiPort||j.port); process.exit(0); } } catch{}
  }' "$WS")
TOKEN=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.zana/auth.json","utf8")).token)}catch{}')
API="http://127.0.0.1:${API_PORT:-$ZANA_PORT}"
AUTH_HDR="Authorization: Bearer $TOKEN"

# -- T2: trigger spawns the agent and history records success ---------------
#
# spawn-agent action returns immediately on spawn (status: success), but the
# agent runs in the daemon. Poll history until the entry is no longer
# `pending` — that's the contract we're testing.

TRIG=$(node dist/bin/zana.js schedule trigger qa-spawn --workspace "$WS" 2>&1)
HIST=""
for i in $(seq 1 120); do
  HIST=$(node dist/bin/zana.js schedule history qa-spawn -n 1 --workspace "$WS" 2>&1)
  if echo "$HIST" | grep -qE "success|error"; then break; fi
  sleep 1
done
if echo "$HIST" | grep -q "success"; then
  record T2 PASS "trigger fired spawn-agent — history success | $HIST"
else
  record T2 FAIL "history did not record success | trig=$TRIG | hist=$HIST"
fi

# -- T3: spawned agent eventually terminates with PONG ----------------------
#
# Hit the daemon's /agents endpoint. The in-memory state lives in the
# daemon process, not in this script, so we MUST go through HTTP.

AGENT_RESULT=""
for i in $(seq 1 120); do
  AGENTS=$(curl -fsS -H "$AUTH_HDR" "$API/agents" 2>/dev/null || true)
  # Find any terminated researcher agent.
  R=$(echo "$AGENTS" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const arr = JSON.parse(d);
        const a = arr.find(x => x.profileId === "researcher" && x.state === "terminated");
        if (a) { console.log(JSON.stringify({ result: (a.result||"").slice(0,300), state: a.state })); }
        else { console.log(JSON.stringify({ pending: arr.length, states: arr.map(x => x.state) })); }
      } catch (e) { console.log(JSON.stringify({ error: e.message })); }
    });')
  if echo "$R" | grep -qi "PONG"; then AGENT_RESULT="$R"; break; fi
  sleep 1
done
if [ -n "$AGENT_RESULT" ]; then
  record T3 PASS "spawned agent terminated with PONG"
else
  # Show the last snapshot for debugging
  AGENTS_FINAL=$(curl -fsS -H "$AUTH_HDR" "$API/agents" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(d);console.log(JSON.stringify(a.map(x=>({id:x.id.slice(0,8),profileId:x.profileId,state:x.state,result:(x.result||"").slice(0,80)}))))}catch(e){console.log(d.slice(0,200))}})')
  record T3 FAIL "spawned agent did not produce PONG | agents=$AGENTS_FINAL"
fi

# -- T4: history retains the run after a second trigger --------------------

node dist/bin/zana.js schedule trigger qa-spawn --workspace "$WS" >/dev/null 2>&1
sleep 1
HIST2=$(node dist/bin/zana.js schedule history qa-spawn -n 5 --workspace "$WS" 2>&1)
LINES=$(echo "$HIST2" | grep -c "|" || true)
if [ "$LINES" -ge 2 ]; then
  record T4 PASS "history retained $LINES entries after re-trigger"
else
  record T4 FAIL "history did not record both runs | $HIST2"
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
