#!/usr/bin/env bash
# Live coverage smoke for every Zana slash command.
#
# Each slash command shells out to one or more `mcp__zana__zana_*` MCP tools
# (declared in its frontmatter under `allowed-tools`). This suite drives
# every one of those tools through the canonical MCP stdio transport
# (zana-mcp-server, JSON-RPC 2.0) — same path Claude Code itself uses.
# No mocks, no stubs, real daemon, real tool dispatch.
#
# Where a tool needs an expensive Claude spawn to do anything meaningful
# (zana_spawn_agent, zana_oneshot_query, zana_deliberate, zana_autopilot_goal_driven,
#  zana_ticket_complete with worker), the spawn path is already covered by:
#   run-runtime.sh, run-ticket-live.sh, run-autopilot-live.sh,
#   run-judge-live.sh, run-scheduler-agent-live.sh
# Here we just verify every slash command's underlying MCP tool surface
# accepts inputs and returns a well-shaped response.
#
# Preconditions: repo built (`npm run build`).

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

WS="/tmp/zana-qa-cmds-$$"
DREG="/tmp/zana-qa-cmds-reg-$$"
mkdir -p "$WS" "$DREG"
export ZANA_DAEMONS_DIR="$DREG"

RESULTS="$REPO/scripts/qa/results/commands.txt"
mkdir -p "$(dirname "$RESULTS")"
: > "$RESULTS"

PASS=0; FAIL=0; SKIP=0
record() {
  printf "%-6s %-4s  %s\n" "$1" "$2" "$3" | tee -a "$RESULTS"
  case "$2" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    SKIP) SKIP=$((SKIP+1)) ;;
  esac
}

cleanup() {
  node dist/bin/zana.js stop --all >/dev/null 2>&1 || true
  rm -rf "$WS" "$DREG"
}
trap cleanup EXIT

# -- daemon -----------------------------------------------------------------

node dist/bin/zana.js init "$WS" >/dev/null 2>&1
node dist/bin/zana.js headless "$WS" --background >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then break; fi
  sleep 0.5
done
if ! node dist/bin/zana.js status 2>/dev/null | grep -q "●"; then
  record D0 FAIL "daemon failed to start"
  exit 1
fi
record D0 PASS "daemon up"

# -- runner: drive MCP server over stdio (canonical path) -------------------
#
# Spawn one `zana-mcp-server` process and pipe a stream of JSON-RPC
# requests at it. The server replies on stdout, one JSON object per
# message. We collect every response and emit a __R__ record per check.

OUT=$(REPO="$REPO" WS="$WS" node - <<'NODE' 2>&1
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = process.env.REPO;
const WS = process.env.WS;

const MCP_BIN = path.join(REPO, "packages/mcp/dist/bin/zana-mcp-server.js");

const out = (id, ok, msg) =>
  console.log(`__R__\t${id}\t${ok ? "PASS" : "FAIL"}\t${String(msg).replace(/\s+/g, " ").slice(0, 180)}`);

// --- MCP stdio client ------------------------------------------------------

const proc = spawn(process.execPath, [MCP_BIN], {
  cwd: WS,
  env: { ...process.env, ZANA_TERMINAL_ID: "qa-cmds-runner" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map(); // id -> resolver
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});
proc.stderr.on("data", () => { /* swallow — MCP servers chatter on stderr */ });

let nextId = 1;
function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  // Tool result text is in r.result.content[0].text (MCP spec).
  const c = r.result?.content?.[0];
  if (c?.type === "text") {
    try { return JSON.parse(c.text); } catch { return c.text; }
  }
  return r.result;
}
function isShape(v) { return v != null && (Array.isArray(v) || typeof v === "object" || typeof v === "string"); }

(async () => {
  // Handshake first.
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "qa-cmds-runner", version: "0" },
  });
  if (init.error) {
    out("INIT", false, `mcp init failed: ${JSON.stringify(init.error)}`);
    process.exit(1);
  }
  // The MCP spec requires the client to follow `initialize` with a
  // `notifications/initialized` notification before tools/* calls work.
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  out("INIT", true, `mcp handshake ok (server: ${init.result?.serverInfo?.name || "?"})`);

  // === /zana:status — calls zana_list_agents, zana_list_running_teams,
  //                    zana_sprint_list, zana_autopilot_goal_list, zana_deliberation_list

  try { const r = await callTool("zana_list_agents"); out("S1", isShape(r), `list_agents: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("S1", false, `list_agents: ${e.message}`); }

  try { const r = await callTool("zana_list_running_teams"); out("S2", isShape(r), `list_running_teams: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("S2", false, `list_running_teams: ${e.message}`); }

  try { const r = await callTool("zana_sprint_list"); out("S3", isShape(r), `sprint_list: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("S3", false, `sprint_list: ${e.message}`); }

  try { const r = await callTool("zana_autopilot_goal_list"); out("S4", isShape(r), `autopilot_goal_list: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("S4", false, `autopilot_goal_list: ${e.message}`); }

  try { const r = await callTool("zana_deliberation_list"); out("S5", isShape(r), `deliberation_list: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("S5", false, `deliberation_list: ${e.message}`); }

  // === /zana:memory — zana_memory_search (and store as setup)

  try {
    await callTool("zana_memory_store", { key: "qa-cmds-test", content: "live qa cmd coverage memory entry", tags: ["qa"] });
    const r = await callTool("zana_memory_search", { query: "live qa cmd coverage", topK: 3 });
    const matches = Array.isArray(r) ? r : (r?.matches || r?.results || []);
    out("M1", Array.isArray(matches), `memory_search returned ${matches.length} match(es)`);
  } catch (e) { out("M1", false, `memory: ${e.message}`); }

  // === /zana:ticket — zana_ticket_create / list / claim / complete

  let ticketId;
  try {
    const r = await callTool("zana_ticket_create", { title: "QA-cmds: roundtrip", priority: "low", description: "metadata-only ticket for live cmd coverage" });
    ticketId = r?.id || r?.ticketId || r?.ticket?.id;
    out("T1", !!ticketId, `ticket_create id=${ticketId || "(missing)"}`);
  } catch (e) { out("T1", false, `ticket_create: ${e.message}`); }

  try {
    const r = await callTool("zana_ticket_list");
    const list = Array.isArray(r) ? r : (r?.tickets || []);
    const found = list.some((t) => t.id === ticketId);
    out("T2", found, `ticket_list found=${found} (n=${list.length})`);
  } catch (e) { out("T2", false, `ticket_list: ${e.message}`); }

  try {
    await callTool("zana_ticket_claim", { ticketId, agentId: "qa-cmds-runner" });
    const r = await callTool("zana_ticket_complete", { ticketId, completedBy: "qa-cmds-runner", resultSummary: "Closed by live cmd coverage suite." });
    out("T3", r?.ok || r?.status === "done", `ticket_complete status=${r?.status || "?"}`);
  } catch (e) { out("T3", false, `ticket complete: ${e.message}`); }

  // === /zana:team — zana_list_teams, zana_get_team, zana_team_status, zana_stop_team

  try { const r = await callTool("zana_list_teams"); const list = Array.isArray(r) ? r : (r?.teams || r?.templates || []); out("TM1", Array.isArray(list), `list_teams returned ${list.length} template(s)`); }
  catch (e) { out("TM1", false, `list_teams: ${e.message}`); }

  // get_team / team_status / stop_team need a real teamId. Verify each
  // handler is reachable by passing a known-bad id and checking it
  // responds with an error (not a transport-level failure).
  for (const [tag, tool] of [["TM2","zana_get_team"],["TM3","zana_team_status"],["TM4","zana_stop_team"]]) {
    try {
      let ok = false;
      try { await callTool(tool, { teamId: "__nonexistent__" }); ok = true; }
      catch (e) { ok = /not found|unknown|missing|invalid/i.test(e.message || ""); }
      out(tag, ok, `${tool} reachable`);
    } catch (e) { out(tag, false, `${tool}: ${e.message}`); }
  }

  // === /zana:autopilot — zana_autopilot_goal_status / cancel (list covered)

  for (const [tag, tool] of [["AP1","zana_autopilot_goal_status"],["AP2","zana_autopilot_goal_cancel"]]) {
    try {
      let ok = false;
      try { await callTool(tool, { goalId: "__nonexistent__" }); ok = true; }
      catch (e) { ok = /not found|unknown|missing|invalid/i.test(e.message || ""); }
      out(tag, ok, `${tool} reachable`);
    } catch (e) { out(tag, false, `${tool}: ${e.message}`); }
  }

  // === /zana:council — zana_deliberation_status / override (list covered)

  for (const [tag, tool, args] of [
    ["C1","zana_deliberation_status",{deliberationId:"__nonexistent__"}],
    ["C2","zana_deliberation_override",{deliberationId:"__nonexistent__",decision:"approve",reason:"qa",humanId:"qa"}],
  ]) {
    try {
      let ok = false;
      try { await callTool(tool, args); ok = true; }
      catch (e) { ok = /not found|unknown|missing|invalid/i.test(e.message || ""); }
      out(tag, ok, `${tool} reachable`);
    } catch (e) { out(tag, false, `${tool}: ${e.message}`); }
  }

  // === /zana:schedule:* — zana_schedule_list / reload / trigger

  try { const r = await callTool("zana_schedule_list"); const list = Array.isArray(r) ? r : (r?.schedules || []); out("SC1", Array.isArray(list), `schedule_list returned ${list.length} schedule(s)`); }
  catch (e) { out("SC1", false, `schedule_list: ${e.message}`); }

  try { const r = await callTool("zana_schedule_reload"); out("SC2", r != null && r.ok !== false, `schedule_reload: ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) { out("SC2", false, `schedule_reload: ${e.message}`); }

  // schedule_trigger needs a real id. Create a disabled schedule, trigger
  // it (handler should respond — either with a dispatch result or an
  // expected "disabled" rejection), then clean up.
  try {
    await callTool("zana_schedule_create", {
      id: "qa-cmds-trigger", name: "qa cmds trigger", enabled: false,
      schedule: { every: "24h" },
      action: { type: "spawn-agent", profileId: "researcher", prompt: "noop" },
    });
    let ok = false;
    try { await callTool("zana_schedule_trigger", { scheduleId: "qa-cmds-trigger" }); ok = true; }
    catch (e) { ok = /disabled|not enabled|forbidden/i.test(e.message || ""); }
    out("SC3", ok, `schedule_trigger reachable`);
    try { await callTool("zana_schedule_delete", { scheduleId: "qa-cmds-trigger" }); } catch {}
  } catch (e) { out("SC3", false, `schedule_trigger setup: ${e.message}`); }

  // === /zana:loop:* — pure Claude Code skills (no MCP tool — they call
  //                    /loop directly). Verify the YAML schema parser they
  //                    share with the daemon round-trips correctly.

  try {
    const { parseYaml } = require(path.join(REPO, "packages/work/dist/src/scheduling/yaml-format.js"));
    const yml = `id: qa-cmds-loop\nname: qa loop\nenabled: true\nschedule:\n  every: 1h\naction:\n  type: spawn-agent\n  profileId: researcher\n  prompt: noop\n`;
    const parsed = parseYaml(yml);
    out("L1", parsed && parsed.id === "qa-cmds-loop", `loop yaml parses → id=${parsed?.id}`);
  } catch (e) { out("L1", false, `loop yaml: ${e.message}`); }

  proc.stdin.end();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.log(`__R__\tFATAL\tFAIL\t${e.message}`);
  proc.stdin.end();
  process.exit(2);
});
NODE
)

# -- collect results --------------------------------------------------------

while IFS=$'\t' read -r _ id status msg; do
  record "$id" "$status" "$msg"
done < <(echo "$OUT" | grep '^__R__')

# Bubble up any non-result lines for debugging.
non_result=$(echo "$OUT" | grep -v '^__R__' || true)
if [ -n "$non_result" ]; then
  echo "--- non-result output (stderr/console) ---" | tee -a "$RESULTS"
  echo "$non_result" | tee -a "$RESULTS"
fi

# -- summary ----------------------------------------------------------------

echo "" | tee -a "$RESULTS"
echo "=== SUMMARY ===" | tee -a "$RESULTS"
echo "PASS: $PASS" | tee -a "$RESULTS"
echo "FAIL: $FAIL" | tee -a "$RESULTS"
echo "SKIP: $SKIP" | tee -a "$RESULTS"
echo "TOTAL: $((PASS+FAIL+SKIP))" | tee -a "$RESULTS"

[ "$FAIL" -eq 0 ]
