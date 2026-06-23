#!/usr/bin/env node
// LIVE nested-spawn MCP verification — NO MOCKING.
//
// Reproduces the bug zcc-cc reported: a HEADLESS/SPAWNED zana agent calling
// daemon-dispatched zana_* tools used to get { error: "unknown action:
// undefined" } — actually rooted in the worker's injected zana MCP server
// CRASHING ON LOAD because the orchestrator-mcp shim require()'d a path that
// doesn't exist (packages/server/mcp/src/mcp-server.js).
//
// This spawns a REAL `claude` worker through the REAL spawner (which injects
// the real orchestrator-mcp shim as the worker's `zana` MCP command), and the
// worker is prompted to call zana_list_profiles and then zana_spawn_agent. We
// assert:
//   1. the worker's zana MCP booted (it answered a tool call at all)
//   2. zana_list_profiles returned real data, NOT "unknown action: undefined"
//   3. zana_spawn_agent returned an agentId (a real GRANDCHILD agent appeared)
//
// Costs real money (one real worker turn on a cheap model). Run only when asked.
//
// Usage: ZANA_DAEMON_TOOLS=1 node scripts/diagnostics/run-nested-spawn-mcp.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));

// The worker MUST see daemon tools to be allowed to call zana_spawn_agent.
process.env.ZANA_DAEMON_TOOLS = "1";

const MODEL = "claude-haiku-4-5-20251001";
const WATCH_MS = 90_000;
const POLL_MS = 2_000;

function hr(label) { console.log("\n" + "═".repeat(72) + `\n${label}\n` + "═".repeat(72)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-nested-"));
  execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

(async () => {
  hr("LIVE NESTED-SPAWN MCP CHECK — real worker calls zana_* (no mocks)");

  const repoDir = makeRepo();
  core.project.workspaceContext.init(repoDir);
  console.log(`workspace: ${repoDir}`);
  console.log(`ZANA_DAEMON_TOOLS=${process.env.ZANA_DAEMON_TOOLS}  model=${MODEL}`);

  const mgr = core.agents.manager;

  // A worker profile. backend-dev is a normal engineering profile; it gets the
  // default zana MCP config injected (defaultZanaMcpConfig → orchestrator-mcp).
  const profile = core.agents.profileStore.getProfile("backend-dev");
  if (!profile) { console.error("FAIL: backend-dev profile missing"); process.exit(1); }
  // Force a cheap model regardless of the profile's tier so this stays cheap.
  // Also: bypassPermissions + an allowlist that INCLUDES the zana MCP tools, so
  // the worker can actually invoke them. backend-dev ships with permissionMode
  // 'acceptEdits' and a Read/Write/Edit/Bash-only allowlist (no mcp__zana__*),
  // which would (correctly) deny the MCP calls — orthogonal to the shim bug we
  // are verifying here. We override BOTH so the dispatch path is exercised.
  const cheapProfile = {
    ...profile,
    model: MODEL,
    permissionMode: "bypassPermissions",
    allowedTools: [
      ...(profile.allowedTools || []),
      "mcp__zana__zana_list_profiles",
      "mcp__zana__zana_spawn_agent",
    ],
  };

  const prompt =
    `You are running headless. You have a zana MCP server available with tools prefixed zana_.\n` +
    `Do EXACTLY these two steps and then stop:\n` +
    `1. Call the tool zana_list_profiles with empty arguments {}. Report how many profiles came back.\n` +
    `2. Call the tool zana_spawn_agent with arguments {"profileId":"researcher","prompt":"Reply with the single word PONG and nothing else."}. Report the agentId it returns.\n` +
    `If either tool returns an error, report the EXACT error string verbatim. Do not write any files. Keep your final message under 6 lines.`;

  // Track grandchildren the worker spawns.
  const spawnedByWorker = [];
  core.events.bus.on(core.events.EVENTS.AGENT_SPAWNED, (p) => {
    spawnedByWorker.push({ t: Date.now(), agentId: p.agentId, profileId: p.profileId });
  });

  hr("spawn the worker (REAL claude child, real injected zana MCP)");
  const { agentId } = mgr.spawnHeadlessAgent(cheapProfile, { prompt, cwd: repoDir });
  console.log(`worker agentId: ${agentId.slice(0, 8)}  pid: ${mgr.getAgent(agentId)?.pid}`);

  // ── Watch until the worker terminates or the window elapses ──────────────
  hr(`watching up to ${WATCH_MS/1000}s for the worker to run its two tool calls`);
  const deadline = Date.now() + WATCH_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const a = mgr.getAgent(agentId);
    if (!a) break;
    if (a.state !== lastState) {
      console.log(`  [${((WATCH_MS-(deadline-Date.now()))/1000).toFixed(0)}s] state=${a.state} action="${(a.lastAction||"").slice(0,60)}"`);
      lastState = a.state;
    }
    if (["terminated", "errored", "error"].includes(a.state)) break;
  }

  const worker = mgr.getAgent(agentId);
  const out = (worker?.result || worker?.lastAssistantText || worker?.outputBuffer || "").toString();
  const stderr = (worker?.stderrBuffer || "").toString();

  hr("WORKER OUTPUT");
  console.log("final state:", worker?.state);
  console.log("--- worker final message / output (tail) ---");
  console.log(out.slice(-1200) || "(empty)");
  if (stderr.trim()) {
    console.log("--- worker stderr (tail) ---");
    console.log(stderr.slice(-600));
  }

  // ── Assertions ───────────────────────────────────────────────────────────
  hr("VERDICT");
  const grandchildren = spawnedByWorker.filter((s) => s.agentId !== agentId);
  const sawUnknownAction = /unknown action:\s*undefined/i.test(out) || /unknown action:\s*undefined/i.test(stderr);
  const sawPermissionDenied = /haven't granted it yet|permission denied|requested permissions/i.test(out);
  // Real success markers, not just the word "profile" (which appears in the
  // permission-denied error text too). A profile-count or a profile id proves
  // list_profiles actually returned data.
  const sawProfiles = !sawUnknownAction && !sawPermissionDenied &&
    (/\b\d+\s+profiles?\b/i.test(out) || /architect|researcher|backend-dev|code-reviewer/i.test(out));
  // The strongest signal: the worker reported a real agentId (uuid) from spawn,
  // or a grandchild agent actually materialized in the manager.
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const reportedAgentId = uuidRe.test(out);
  const grandchildAppeared = grandchildren.length > 0;

  console.log(`unknown-action-undefined seen: ${sawUnknownAction}`);
  console.log(`permission-denied seen: ${sawPermissionDenied}`);
  console.log(`zana_list_profiles answered with data: ${sawProfiles}`);
  console.log(`worker reported a spawned agentId: ${reportedAgentId}`);
  console.log(`grandchild agent(s) materialized: ${grandchildAppeared} ${grandchildren.map(g=>g.profileId+"/"+g.agentId.slice(0,8)).join(", ")}`);

  let exitCode;
  if (sawUnknownAction) {
    console.log(`\n❌ FAIL: the bug is still present — "unknown action: undefined" returned to a nested caller.`);
    exitCode = 1;
  } else if ((grandchildAppeared || reportedAgentId) && sawProfiles) {
    console.log(`\n✅ PASS: a spawned agent successfully called zana_list_profiles AND zana_spawn_agent (real nested spawn worked).`);
    exitCode = 0;
  } else if (sawProfiles) {
    console.log(`\n⚠️  PARTIAL: list_profiles worked (MCP booted, no unknown-action) but spawn_agent result wasn't clearly observed. Inspect output above.`);
    exitCode = 2;
  } else {
    console.log(`\n⚠️  INCONCLUSIVE: worker did not clearly report tool results (model may not have called tools). MCP boot is separately proven by the shim smoke test. Inspect output above.`);
    exitCode = 2;
  }

  // ── Teardown: kill worker + any grandchildren so nothing keeps billing ────
  try { mgr.killAgent(agentId); } catch {}
  for (const g of grandchildren) { try { mgr.killAgent(g.agentId); } catch {} }
  await sleep(1500);
  try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  console.log("\ndone.");
  process.exit(exitCode);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
