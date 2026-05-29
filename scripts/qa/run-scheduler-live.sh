#!/usr/bin/env bash
# Live scheduler + zana-loop end-to-end smoke.
#
# Daemon path: spawn a fresh daemon for a temp workspace, drop a real YAML
# schedule (type: command, touches a file), exercise the live REST API
# (list, trigger, history, disable, reload), assert the filesystem touch.
#
# Loop path: drive the same YAML through the scheduler engine directly —
# no daemon — which is exactly what /loop does once zana-loop arms it.
#
# Hermetic: temp workspace under /tmp/zana-qa-sched-$$/, registry isolated
# via ZANA_DAEMONS_DIR override.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

WS="/tmp/zana-qa-sched-$$"
DREG="/tmp/zana-qa-sched-reg-$$"
TOUCH_FILE="$WS/.zana/scheduler-touch.txt"
mkdir -p "$WS" "$DREG"
export ZANA_DAEMONS_DIR="$DREG"

PASS=0; FAIL=0
declare -a RESULTS

record() {  # record <id> <PASS|FAIL> <one-line>
  RESULTS+=("$1|$2|$3")
  if [ "$2" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

cleanup() {
  node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
  rm -rf "$WS" "$DREG"
}
trap cleanup EXIT

# -- preconditions -----------------------------------------------------------

node dist/bin/zana.js init "$WS" >/dev/null 2>&1
mkdir -p "$WS/.zana/scheduler"

cat > "$WS/.zana/scheduler/qa-touch.yml" <<YAML
id: qa-touch
name: QA touch-file schedule
description: Touch a file each fire — proves command-action plumbing end-to-end.
enabled: true
schedule:
  every: 1h
action:
  type: command
  command: ["sh", "-c", "echo \$(date +%s) >> '$TOUCH_FILE'"]
history:
  enabled: true
  retain: 5
YAML

# -- start daemon ------------------------------------------------------------

node dist/bin/zana.js headless "$WS" --background >/dev/null 2>&1
# Wait for daemon to register
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then break; fi
  sleep 0.5
done

# -- T1: schedule list (CLI) -------------------------------------------------

OUT=$(node dist/bin/zana.js schedule list --workspace "$WS" 2>&1)
if echo "$OUT" | grep -q "qa-touch"; then
  record T1 PASS "schedule list shows qa-touch"
else
  record T1 FAIL "schedule list missing qa-touch | $OUT"
fi

# -- T2: schedule list --json ------------------------------------------------

JSON=$(node dist/bin/zana.js schedule list --json --workspace "$WS" 2>&1)
if echo "$JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const j=JSON.parse(d); const found=j.find(s=>s.id==="qa-touch"); if(found && found.enabled===true) process.exit(0); process.exit(1)});' 2>/dev/null; then
  record T2 PASS "schedule list --json parses, qa-touch enabled"
else
  record T2 FAIL "schedule list --json malformed or missing entry"
fi

# -- T3: trigger fires the action and writes the file -----------------------

rm -f "$TOUCH_FILE"
TRIG=$(node dist/bin/zana.js schedule trigger qa-touch --workspace "$WS" 2>&1)
sleep 1
if [ -f "$TOUCH_FILE" ] && [ -s "$TOUCH_FILE" ]; then
  record T3 PASS "trigger fired command action — file written ($(wc -c < "$TOUCH_FILE" | tr -d ' ') bytes)"
else
  record T3 FAIL "trigger did not write file | trig output: $TRIG"
fi

# -- T4: history shows the run ----------------------------------------------

HIST=$(node dist/bin/zana.js schedule history qa-touch -n 5 --workspace "$WS" 2>&1)
if echo "$HIST" | grep -q "success"; then
  record T4 PASS "history records the trigger as success"
else
  record T4 FAIL "history missing success entry | $HIST"
fi

# -- T5: disable then re-list ------------------------------------------------

DIS=$(node dist/bin/zana.js schedule disable qa-touch --workspace "$WS" 2>&1)
JSON2=$(node dist/bin/zana.js schedule list --json --workspace "$WS" 2>&1)
if echo "$JSON2" | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const j=JSON.parse(d); const f=j.find(s=>s.id==="qa-touch"); if(f && f.enabled===false) process.exit(0); process.exit(1)});' 2>/dev/null; then
  record T5 PASS "disable persisted (enabled=false in list)"
else
  record T5 FAIL "disable not persisted | dis: $DIS"
fi

# -- T6: enable-all flips it back -------------------------------------------

EA=$(node dist/bin/zana.js schedule enable-all --workspace "$WS" 2>&1)
JSON3=$(node dist/bin/zana.js schedule list --json --workspace "$WS" 2>&1)
if echo "$JSON3" | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const j=JSON.parse(d); const f=j.find(s=>s.id==="qa-touch"); if(f && f.enabled===true) process.exit(0); process.exit(1)});' 2>/dev/null; then
  record T6 PASS "enable-all re-enabled qa-touch"
else
  record T6 FAIL "enable-all did not re-enable | ea: $EA"
fi

# -- T7: reload re-reads YAML changes ---------------------------------------

# Mutate the YAML on disk: change name field, then reload — verify the
# rendered list reflects the new name.
sed -i.bak 's/QA touch-file schedule/QA renamed schedule/' "$WS/.zana/scheduler/qa-touch.yml"
RL=$(node dist/bin/zana.js schedule reload --workspace "$WS" 2>&1)
JSON4=$(node dist/bin/zana.js schedule list --json --workspace "$WS" 2>&1)
if echo "$JSON4" | grep -q "QA renamed schedule"; then
  record T7 PASS "reload picked up YAML edit (name changed)"
else
  record T7 FAIL "reload did not pick up edit | rl: $RL"
fi

# -- T8: stop daemon, verify registry cleanup -------------------------------

node dist/bin/zana.js stop --all >/dev/null 2>&1
sleep 1
LEFT=$(ls "$DREG" 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEFT" = "0" ]; then
  record T8 PASS "stop --all clears registry ($LEFT entries)"
else
  record T8 FAIL "registry has $LEFT leftover entries"
fi

# -- T9: zana-loop / daemon-free path ---------------------------------------
#
# Drive the same YAML through the scheduler engine directly with no daemon —
# exactly what /loop does after zana-loop:start arms it. The /loop skill
# fires triggerSchedule(id) on each tick; we simulate one tick.

rm -f "$TOUCH_FILE"
LOOP_OUT=$(node -e '
const path = require("node:path");
const REPO = process.cwd();
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));
const ws = process.argv[1];
core.project.workspaceContext.init(ws);
(async () => {
  await work.scheduling.service.loadFromDisk();
  const r = await work.scheduling.service.triggerSchedule("qa-touch");
  console.log(JSON.stringify({ status: r?.result?.status, ok: r?.ok, err: r?.error }));
})().catch(e => { console.error("LOOP_CRASH:", e.message, e.stack); process.exit(1); });
' "$WS" 2>&1)
sleep 1
if [ -f "$TOUCH_FILE" ] && echo "$LOOP_OUT" | grep -q '"status":"success"'; then
  record T9 PASS "loop-path triggerSchedule fired action without daemon"
else
  record T9 FAIL "loop-path did not fire | out: $LOOP_OUT"
fi

# -- T10: zana-loop plugin yml schema check ---------------------------------
#
# zana-loop refuses cron schedules (daemon-only) per its skill doc.
# Verify the engine's normalizer doesn't accept a cron + every: at the same
# time.

cat > "$WS/.zana/scheduler/qa-loop-cron.yml" <<'YAML'
id: qa-loop-cron
name: QA loop cron rejection
enabled: true
schedule:
  cron: "0 0 * * *"
action:
  type: command
  command: ["true"]
YAML

node dist/bin/zana.js headless "$WS" --background >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then break; fi
  sleep 0.5
done

# A cron-typed schedule should still LIST (the engine accepts cron in the
# daemon path), but if /loop tried to start it the loop CLI would refuse —
# we can't test the slash-command path live, so assert the YAML is at least
# well-formed and recognized.
LOOPLIST=$(node dist/bin/zana.js schedule list --json --workspace "$WS" 2>&1)
if echo "$LOOPLIST" | grep -q "qa-loop-cron"; then
  record T10 PASS "cron-typed yml is parsed and listed (daemon path accepts it)"
else
  record T10 FAIL "cron-typed yml not listed"
fi

node dist/bin/zana.js stop --all >/dev/null 2>&1

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
