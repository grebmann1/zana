#!/usr/bin/env node
// Live comparison: Claude Code SUBAGENT dispatch vs Zana PROCESS spawn.
//
// Phase 1 (free): spawn an engineer team via teamManager.startTeam in BOTH
//   execution strategies with the agent spawn STUBBED, and print exactly what
//   each would launch — provisioned .claude/agents/*.md recipes + the lead's
//   Tier-0 prompt (subagent), vs the orchestrator prompt + per-worker process
//   spawns (process). This answers "are we doing things as expected?" with no
//   spend.
//
// Phase 2 (LIVE, costs money — pass --live): run the SAME small engineering
//   task two ways in a throwaway git repo, with cheap models:
//     S) ONE `claude` lead that dispatches the provisioned engineer subagents
//        via the Task tool (the subagent strategy, reproduced as a one-shot).
//     P) Zana spawns a coder worker (one process) then a reviewer worker
//        (another process) — the default process strategy.
//   It captures wall-time, cost, process count, and whether subagents were
//   actually dispatched, then prints a comparison the next-phase plan builds on.
//
// Usage:
//   node scripts/diagnostics/run-subagent-vs-process.js            # phase 1 only
//   node scripts/diagnostics/run-subagent-vs-process.js --live     # + phase 2

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));
const provisioner = core.agents.subagentProvisioner;

const LIVE = process.argv.includes("--live");
const MODEL = "claude-haiku-4-5-20251001";

function findClaude() {
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(local)) return local;
  return "claude";
}
const CLAUDE = findClaude();

function hr(label) { console.log("\n" + "═".repeat(72) + `\n${label}\n` + "═".repeat(72)); }

// ── A throwaway git repo so the lead/workers have a real cwd ────────────────
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-savp-"));
  execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

// The engineer team we test with: a coder + a reviewer.
const TEAM = {
  id: "eng-smoke",
  name: "Engineer Smoke Team",
  slug: "eng-smoke",
  orchestratorProfileId: "orchestrator",
  workerProfileIds: ["backend-dev", "code-reviewer"],
  slots: [
    { profileId: "backend-dev", quantity: 1 },
    { profileId: "code-reviewer", quantity: 1 },
  ],
};

const TASK =
  "Create a file calc.js exporting a function add(a, b) that returns a + b. " +
  "Keep it tiny. Then have it reviewed for correctness.";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — inspect what each strategy LAUNCHES (spawn stubbed, no spend)
// ─────────────────────────────────────────────────────────────────────────────
function phase1(repoDir) {
  hr("PHASE 1 — what does startTeam launch in each strategy? (stubbed, free)");

  core.project.workspaceContext.init(repoDir);

  // Stub the spawn so nothing real launches; capture the augmented profile.
  // IMPORTANT: spawnHeadlessAgent is a read-only getter on the manager facade
  // (ESM re-export of ./lifecycle), so reassigning it on core.agents.manager
  // silently no-ops. Patch the lifecycle module itself (writable CJS export) —
  // the manager getter reads that live binding. Same for writeToAgent so the
  // 2s kickoff timer can't fire a real write.
  const lifecycle = require(path.join(REPO, "packages/core/dist/src/agents/lifecycle.js"));
  const captured = [];
  const realSpawn = lifecycle.spawnHeadlessAgent;
  const realWrite = lifecycle.writeToAgent;
  lifecycle.spawnHeadlessAgent = (profile, opts) => {
    captured.push({ profile, opts });
    return { agentId: `stub-${captured.length}`, terminalId: null };
  };
  lifecycle.writeToAgent = () => {};
  // Make the team resolvable + profiles real.
  const realGetTeam = work.teams.store.getTeam;
  work.teams.store.getTeam = (id) => (id === TEAM.id ? TEAM : realGetTeam(id));

  // stopTeam defers the running-map delete behind a 3s timer; in a sync script
  // that never elapses, so force-clear the running team between iterations by
  // re-importing is overkill — instead use a UNIQUE team id per strategy.
  let iter = 0;
  for (const strategy of ["subagent", "process"]) {
    iter++;
    captured.length = 0;
    try { fs.rmSync(path.join(repoDir, ".claude"), { recursive: true, force: true }); } catch {}
    const teamId = `${TEAM.id}-${strategy}`;
    work.teams.store.getTeam = (id) =>
      (id === teamId ? { ...TEAM, id: teamId, executionStrategy: strategy } : realGetTeam(id));
    const res = work.teams.manager.startTeam(teamId, { headless: true, cwd: repoDir });

    console.log(`\n### strategy = ${strategy}`);
    console.log("startTeam →", JSON.stringify({ ok: res.ok, executionStrategy: res.executionStrategy, subagents: res.subagents, error: res.error }, null, 2));
    console.log(`processes the lead's spawn used: ${captured.length} (expect 1 for both — the lead)`);

    if (strategy === "subagent") {
      const agentsDir = path.join(repoDir, ".claude", "agents");
      const files = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : [];
      console.log(`provisioned recipes: ${JSON.stringify(files)}`);
      for (const f of files) {
        console.log(`\n--- .claude/agents/${f} ---`);
        console.log(fs.readFileSync(path.join(agentsDir, f), "utf8"));
      }
      const lead = captured[0]?.profile;
      console.log("--- lead appendSystemPrompt (Tier-0 directive, head) ---");
      console.log((lead?.appendSystemPrompt || "(none)").slice(0, 900));
    } else {
      const lead = captured[0]?.profile;
      console.log("--- lead appendSystemPrompt (orchestrator prompt, head) ---");
      console.log((lead?.appendSystemPrompt || "(none)").slice(0, 700));
      console.log("(in process mode the lead spawns workers at RUNTIME via zana_spawn_agent — not visible in a stub)");
    }
    try { work.teams.manager.stopTeam(teamId); } catch {}
  }

  // restore
  lifecycle.spawnHeadlessAgent = realSpawn;
  lifecycle.writeToAgent = realWrite;
  work.teams.store.getTeam = realGetTeam;
  try { fs.rmSync(path.join(repoDir, ".claude"), { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — LIVE runs
// ─────────────────────────────────────────────────────────────────────────────

// Run a single `claude -p` and collect stream-json frames.
function runClaude(args, cwd, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(CLAUDE, args, { cwd, env: process.env });
    let out = "";
    let err = "";
    const taskDispatches = [];
    let result = null, cost = 0, turns = 0, sessionId = null;
    child.stdout.on("data", (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "assistant" && msg.message?.content) {
            for (const b of msg.message.content) {
              // The subagent-dispatch tool is named "Agent" in claude CLI 2.1.x
              // (older docs call it "Task"); accept both. The input carries the
              // recipe name as `subagent_type`.
              if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
                taskDispatches.push(b.input?.subagent_type || b.input?.description || "(unknown)");
              }
            }
          }
          if (msg.type === "result") {
            result = msg.result; cost = msg.total_cost_usd || 0; turns = msg.num_turns || 0;
            sessionId = msg.session_id;
          }
        } catch {}
      }
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      resolve({ label, code, ms: Date.now() - t0, result, cost, turns, taskDispatches, sessionId, stderr: err.slice(-400) });
    });
  });
}

async function phase2() {
  hr("PHASE 2 — LIVE: subagent dispatch vs process spawn (same task)");
  console.log(`model=${MODEL}  task="${TASK}"\n`);

  // ---- Run S: subagent strategy (one lead dispatches provisioned subagents) ----
  const repoS = makeRepo();
  core.project.workspaceContext.init(repoS);
  const profiles = TEAM.workerProfileIds.map((id) => core.agents.profileStore.getProfile(id));
  const prov = provisioner.provisionTeam({ workingDirectory: repoS, teamSlug: TEAM.slug, profiles });
  const roster = profiles.map((p) => provisioner.compositeSlug(TEAM.slug, p.id));
  console.log(`[S] provisioned ${prov.map((r) => r.name).join(", ")} (${prov.map((r) => r.outcome).join("/")})`);
  const leadPrompt =
    `You are the LEAD of an engineering team. You orchestrate; you do NOT write code yourself.\n` +
    `Dispatch teammates as SUBAGENTS via the Task tool using these exact subagent_type values:\n` +
    roster.map((r) => `- ${r}`).join("\n") +
    `\n\nTask: ${TASK}\nDispatch the coder subagent to create the file, then the reviewer subagent to verify it. Report what each returned.`;
  // --strict-mcp-config: a subagent-mode lead must run with a CLEAN tool surface.
  // Without it the spawned child inherits the host's MCP servers (here the
  // cockpit's ZCC task tools), which collide with / shadow the built-in Agent
  // dispatch tool — the lead grabbed TaskCreate/TaskUpdate instead of Agent and
  // never delegated. This flag is the production fix (spawner should set it for
  // subagent leads).
  const runS = await runClaude(
    ["-p", leadPrompt, "--model", MODEL, "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"],
    repoS, "subagent",
  );
  runS.fileCreated = fs.existsSync(path.join(repoS, "calc.js"));
  runS.processCount = 1;

  // ---- Run P: process strategy (Zana spawns coder, then reviewer) ----
  const repoP = makeRepo();
  // Coder process
  const coderPrompt = `${TASK}\nYou are the coder. Create calc.js now.`;
  const runP_coder = await runClaude(
    ["-p", coderPrompt, "--model", MODEL, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"],
    repoP, "process:coder",
  );
  // Reviewer process (separate OS process — the essence of process mode)
  const reviewPrompt = `You are a code reviewer. Read calc.js in this repo and reply PASS if add(a,b) correctly returns a+b, else FAIL with the reason.`;
  const runP_rev = await runClaude(
    ["-p", reviewPrompt, "--model", MODEL, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"],
    repoP, "process:reviewer",
  );
  const runP = {
    label: "process",
    ms: runP_coder.ms + runP_rev.ms,
    cost: runP_coder.cost + runP_rev.cost,
    turns: runP_coder.turns + runP_rev.turns,
    taskDispatches: [],
    processCount: 2,
    fileCreated: fs.existsSync(path.join(repoP, "calc.js")),
    coderResult: (runP_coder.result || "").slice(0, 120),
    reviewerResult: (runP_rev.result || "").slice(0, 120),
  };

  hr("RESULTS");
  console.log("SUBAGENT run:", JSON.stringify({
    code: runS.code, ms: runS.ms, cost: +runS.cost.toFixed(4), turns: runS.turns,
    processCount: runS.processCount, dispatchedSubagents: runS.taskDispatches,
    fileCreated: runS.fileCreated, result: (runS.result || "").slice(0, 160),
    stderr: runS.stderr ? runS.stderr.slice(-200) : "",
  }, null, 2));
  console.log("\nPROCESS run:", JSON.stringify({
    ms: runP.ms, cost: +runP.cost.toFixed(4), turns: runP.turns,
    processCount: runP.processCount, fileCreated: runP.fileCreated,
    coderResult: runP.coderResult, reviewerResult: runP.reviewerResult,
  }, null, 2));

  console.log("\nCOMPARISON:");
  console.log(`  processes:  subagent=1   process=2`);
  console.log(`  cost(USD):  subagent=${runS.cost.toFixed(4)}   process=${runP.cost.toFixed(4)}`);
  console.log(`  walltime:   subagent=${(runS.ms/1000).toFixed(1)}s   process=${(runP.ms/1000).toFixed(1)}s`);
  console.log(`  subagent dispatch worked: ${runS.taskDispatches.length > 0 ? "YES → " + runS.taskDispatches.join(", ") : "NO (lead did not use Task)"}`);
  console.log(`  files produced: subagent=${runS.fileCreated}  process=${runP.fileCreated}`);

  return { runS, runP };
}

(async () => {
  const repoDir = makeRepo();
  phase1(repoDir);
  if (LIVE) {
    await phase2();
  } else {
    hr("PHASE 2 skipped (pass --live to run the paid comparison)");
  }
  console.log("\ndone.");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
