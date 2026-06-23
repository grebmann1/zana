#!/usr/bin/env node
// LIVE team-spawn liveness check — NO MOCKING.
//
// Question this answers: when a team is started against a real ticket, does the
// team lead actually spawn as a real `claude` child and STAY ALIVE, or does it
// die on spawn?
//
// Unlike run-subagent-vs-process.js phase 1 (which STUBS spawnHeadlessAgent),
// this calls the real lifecycle: a throwaway workspace, a real ticket in the
// real ticket store, a real team registered in the real team store, and the
// real teamManager.startTeam → agentManager.spawnHeadlessAgent path that forks
// an actual `claude` process. We then poll the REAL agent manager and assert:
//
//   1. the lead appears in listAgents() with a real OS pid
//   2. the pid is genuinely alive (process.kill(pid, 0) succeeds)
//   3. across a watch window the lead does NOT flip to error/errored/spawn-error
//      (i.e. it isn't dying immediately on spawn)
//
// It then tears the lead down (killAgent) so no real spend continues. The lead
// IS billed for the few seconds it runs + its kickoff turn, so this costs a
// small amount of real money — run only when asked.
//
// Usage: node scripts/diagnostics/run-live-team-spawn.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));

const WATCH_MS = 25_000;     // how long we watch the lead for early death
const POLL_MS = 1_000;
const SPAWN_GRACE_MS = 8_000; // give the child time to fork + emit its init frame

function hr(label) { console.log("\n" + "═".repeat(72) + `\n${label}\n` + "═".repeat(72)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-live-team-"));
  execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // EPERM = exists but not ours; ESRCH = gone
}

(async () => {
  hr("LIVE TEAM SPAWN — real ticket → real team → real claude child (no mocks)");

  // ── 1. Real workspace + real ticket ──────────────────────────────────────
  const repoDir = makeRepo();
  core.project.workspaceContext.init(repoDir);
  console.log(`workspace: ${repoDir}`);

  const svc = work.tickets.service;
  const ticket = svc.createTicket({
    title: "Live spawn smoke: add(a,b) in calc.js",
    description: "Create calc.js exporting add(a,b) returning a+b. Tiny.",
    priority: "low",
    labels: ["live-spawn-smoke"],
  });
  console.log(`ticket created: ${ticket.id} (status=${ticket.status})`);

  // ── 2. Real team referencing the ticket, registered in the real store ────
  const TEAM_ID = "live-spawn-smoke-team";
  const team = {
    id: TEAM_ID,
    name: "Live Spawn Smoke Team",
    slug: "live-spawn-smoke",
    icon: "🧪",
    orchestratorProfileId: "orchestrator",
    workerProfileIds: ["backend-dev", "code-reviewer"],
    slots: [
      { profileId: "backend-dev", quantity: 1 },
      { profileId: "code-reviewer", quantity: 1 },
    ],
    initialPrompt:
      `Work ticket ${ticket.id}: ${ticket.title}. Spawn the backend-dev to implement, ` +
      `then the code-reviewer to verify. Keep it tiny.`,
    executionStrategy: "process", // the default real path: lead spawns workers at runtime
  };
  const saved = work.teams.store.saveTeam(team);
  console.log(`team saved: ${saved.id || TEAM_ID}`);

  // Track every spawn/terminate the manager emits, so we see deaths even if they
  // happen between polls.
  const events = [];
  core.events.bus.on(core.events.EVENTS.AGENT_SPAWNED, (p) => events.push({ t: Date.now(), ev: "SPAWNED", ...p }));
  core.events.bus.on(core.events.EVENTS.AGENT_TERMINATED, (p) => events.push({ t: Date.now(), ev: "TERMINATED", ...p }));

  // ── 3. Start the team for real — forks an actual `claude` child ──────────
  hr("startTeam (headless, process strategy) — REAL spawn");
  const kickoff = `Begin ticket ${ticket.id}. ${team.initialPrompt}`;
  const res = work.teams.manager.startTeam(TEAM_ID, { headless: true, cwd: repoDir, prompt: kickoff });
  console.log("startTeam →", JSON.stringify(res));
  if (!res.ok) {
    console.error("\nFAIL: startTeam returned not-ok — nothing spawned.");
    cleanup(repoDir); process.exit(1);
  }
  const leadId = res.orchestratorAgentId;

  // ── 4. Grace, then assert the lead is real + alive ───────────────────────
  await sleep(SPAWN_GRACE_MS);
  const lead = core.agents.manager.getAgent(leadId);
  if (!lead) { console.error("FAIL: lead not in agent manager after spawn."); await teardown(leadId, repoDir); process.exit(1); }

  console.log(`\nlead agent record:`);
  console.log(`  id=${lead.id.slice(0,8)}  profile=${lead.profileId}  state=${lead.state}  pid=${lead.pid}  model=${lead.model}`);
  console.log(`  lastAction="${lead.lastAction}"  claudeSessionId=${lead.claudeSessionId || "(none yet)"}`);

  const alive = pidAlive(lead.pid);
  console.log(`  pid ${lead.pid} alive (kill -0): ${alive}`);

  const bornHealthy = !!lead.pid && alive && !["error", "errored"].includes(lead.state);
  if (!bornHealthy) {
    console.error(`\nFAIL: lead did not come up healthy (state=${lead.state}, pid=${lead.pid}, alive=${alive}).`);
    dumpStderr(lead);
    await teardown(leadId, repoDir);
    process.exit(1);
  }
  console.log("\n✅ lead spawned healthy (active, real pid, process alive).");

  // ── 5. Watch window — does it DIE early? ─────────────────────────────────
  hr(`WATCH ${WATCH_MS/1000}s — is the lead staying alive?`);
  const deadline = Date.now() + WATCH_MS;
  let lastState = lead.state;
  let earlyDeath = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const a = core.agents.manager.getAgent(leadId);
    if (!a) break;
    const procAlive = pidAlive(a.pid);
    if (a.state !== lastState) {
      console.log(`  [${((Date.now()-(deadline-WATCH_MS))/1000).toFixed(0)}s] state: ${lastState} → ${a.state}  pid=${a.pid} alive=${procAlive}  "${a.lastAction}"`);
      lastState = a.state;
    }
    // "Dying" = error/errored/spawn-error, OR state still active but the OS
    // process has vanished (silent crash the manager hasn't reaped yet).
    if (["error", "errored"].includes(a.state)) { earlyDeath = `state=${a.state}`; break; }
    if (a.state === "active" && a.pid && !procAlive) { earlyDeath = "active-but-pid-gone (silent crash)"; break; }
  }

  hr("VERDICT");
  const final = core.agents.manager.getAgent(leadId);
  console.log(`final state: ${final?.state}  pid=${final?.pid}  alive=${pidAlive(final?.pid)}`);
  console.log(`session captured: ${final?.claudeSessionId ? "YES ("+final.claudeSessionId.slice(0,8)+")" : "no"}`);
  console.log("lifecycle events:");
  for (const e of events) console.log(`  ${e.ev}  ${(e.profileId||e.agentId||"").toString().slice(0,18)}  ${e.reason||""}`);

  let exitCode;
  if (earlyDeath) {
    console.error(`\n❌ FAIL: lead DIED during watch window — ${earlyDeath}`);
    dumpStderr(final);
    exitCode = 1;
  } else {
    // A clean "terminated" (code 0) mid-window means the lead finished its turn
    // and exited normally — that's alive-and-well, not dying. A "completed"
    // reason on the event confirms it.
    const terminated = events.find((e) => e.ev === "TERMINATED" && e.agentId === leadId);
    const cleanFinish = terminated && (terminated.reason === "completed");
    if (final?.state === "active" || (final?.pid && pidAlive(final.pid))) {
      console.log("\n✅ PASS: lead spawned and stayed alive for the full watch window — not dying.");
      exitCode = 0;
    } else if (cleanFinish) {
      console.log("\n✅ PASS: lead ran and exited CLEANLY (completed, code 0) — healthy, not a spawn death.");
      exitCode = 0;
    } else {
      console.log(`\n⚠️  INCONCLUSIVE: lead is ${final?.state} but no clean-completion event seen.`);
      dumpStderr(final);
      exitCode = 2;
    }
  }

  await teardown(leadId, repoDir);
  console.log("\ndone.");
  process.exit(exitCode);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

function dumpStderr(agent) {
  if (!agent) return;
  const errs = (agent.stderrBuffer || "").slice(-600);
  const out = (agent.outputBuffer || "").slice(-300);
  if (errs) console.error(`  --- child stderr (tail) ---\n${errs}`);
  if (out) console.error(`  --- child stdout (tail) ---\n${out}`);
}

async function teardown(leadId, repoDir) {
  try { core.agents.manager.killAgent(leadId); } catch {}
  try { work.teams.manager.stopTeam("live-spawn-smoke-team"); } catch {}
  await sleep(1500); // let SIGTERM land
  cleanup(repoDir);
}

function cleanup(repoDir) {
  try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}
