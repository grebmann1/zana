#!/usr/bin/env node
// LIVE verification of spawn cwd confinement — real dispatch, no mocks.
//
// Exercises the REAL handleOrchestratorCommand("spawn_agent", …) path that an
// MCP client / nested agent hits, with a real workspace:
//   1. cwd inside the workspace  → accepted, worker spawns with that cwd
//   2. cwd OUTSIDE the workspace → refused with an error, NO spawn
//   3. cwd escaping via symlink  → refused (realpath catches it), NO spawn
//   4. unknown projectId         → refused, NO spawn
//
// (1) spawns ONE real claude child briefly then kills it (small real spend);
// (2)-(4) are refused before any process starts, so they cost nothing.
//
// Usage: node scripts/diagnostics/run-spawn-cwd-confinement.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hr(l) { console.log("\n" + "═".repeat(72) + `\n${l}\n` + "═".repeat(72)); }

function makeRepo(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

// Call the REAL dispatcher exactly as the MCP server's callCore does.
function dispatch(action, params, workspace) {
  return core.agents.manager.handleOrchestratorCommand(
    { _action: action, ...params },
    () => workspace,
  );
}

(async () => {
  hr("LIVE spawn cwd confinement — real dispatch (no mocks)");

  const workspace = makeRepo("scwd-ws-");
  const outside = makeRepo("scwd-out-");
  core.project.workspaceContext.init(workspace);
  const sub = path.join(workspace, "pkg");
  fs.mkdirSync(sub, { recursive: true });
  console.log(`workspace: ${workspace}`);
  console.log(`outside:   ${outside}`);

  const results = [];
  const spawned = [];

  // ── 2-4 first (free, refused before spawn) ───────────────────────────────
  hr("refusal cases (no spend — refused before any process starts)");

  const rOutside = await dispatch("spawn_agent", { profileId: "backend-dev", prompt: "noop", cwd: outside }, workspace);
  console.log(`cwd outside workspace → ${JSON.stringify(rOutside)}`);
  results.push(["cwd outside refused", !!rOutside.error && !rOutside.agentId]);

  const link = path.join(workspace, "escape-link");
  fs.symlinkSync(outside, link);
  const rLink = await dispatch("spawn_agent", { profileId: "backend-dev", prompt: "noop", cwd: link }, workspace);
  console.log(`cwd symlink→outside  → ${JSON.stringify(rLink)}`);
  results.push(["symlink escape refused", !!rLink.error && !rLink.agentId]);

  const rProj = await dispatch("spawn_agent", { profileId: "backend-dev", prompt: "noop", projectId: "proj_does_not_exist" }, workspace);
  console.log(`unknown projectId    → ${JSON.stringify(rProj)}`);
  results.push(["unknown projectId refused", !!rProj.error && !rProj.agentId]);

  // ── 1: accepted cwd actually spawns with that cwd (real, brief) ──────────
  hr("accept case (real spawn — confined sub-dir)");
  const rOk = await dispatch("spawn_agent", { profileId: "backend-dev", prompt: "Reply with the single word OK and stop.", cwd: sub }, workspace);
  console.log(`cwd inside workspace → ${JSON.stringify(rOk)}`);
  const accepted = !!rOk.agentId && !rOk.error;
  results.push(["confined cwd accepted (spawned)", accepted]);
  if (accepted) {
    spawned.push(rOk.agentId);
    await sleep(2500);
    const a = core.agents.manager.getAgent(rOk.agentId);
    const cwdMatches = a && a.cwd === sub;
    console.log(`spawned agent cwd = ${a?.cwd}  (expected ${sub})  state=${a?.state} pid=${a?.pid}`);
    results.push(["spawned agent runs in the confined cwd", !!cwdMatches]);
  }

  // ── teardown ─────────────────────────────────────────────────────────────
  for (const id of spawned) { try { core.agents.manager.killAgent(id); } catch {} }
  await sleep(1200);
  for (const d of [workspace, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

  hr("VERDICT");
  let pass = true;
  for (const [name, ok] of results) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "\n✅ PASS: confinement enforced on the real dispatch path." : "\n❌ FAIL: see above.");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
