#!/usr/bin/env node
// Cheap real-Claude smoke test for the snap-judgment prompt rewrite.
// Single voter, 1 round, narrower question, 8-min ceiling.
//
// Goal: verify the new prompt actually keeps voters in budget (≤5 min,
// ≤5 tool calls) instead of doing 60-min audits.
//
// Cost: ~$0.50-1 (1 voter × sonnet-4-6 × small context). Cheap enough
// to iterate on prompt design.

const path = require("node:path");
const fs = require("node:fs");
const REPO = path.resolve(__dirname, "..", "..");

const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));

core.project.workspaceContext.init(REPO);
work.runs.checkpoint.store.init(REPO);

const { deliberateHandler, deliberationStatusHandler } = require(
  path.join(REPO, "packages/mcp/dist/src/tools/deliberate.js"),
);

(async () => {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] starting cheap snap-judgment test (1 voter, 1 round)`);

  const stub = await deliberateHandler({
    question:
      "I'm considering renaming the variable `inflightAgents` in " +
      "packages/work/src/scheduling/service.ts to `pendingAgentResults`. " +
      "It tracks agentId → {scheduleId, spawnedAt} so the AGENT_TERMINATED " +
      "handler can patch the right history entry. " +
      "APPROVE the rename, or CHANGES if you'd suggest a different name " +
      "(or none at all). One voter, snap judgment.",
    voters: ["architect"],
    rounds: 1,
    quorum: 1,
    riskTag: "low",
  });

  console.log(`[stub] state=${stub.state} id=${stub.id}`);

  // Poll up to 12 min total — voter has 5-min budget; padding for
  // probe + synthesis + decide.
  const deadline = Date.now() + 12 * 60 * 1000;
  let lastState = "PROPOSED";
  let final;
  while (Date.now() < deadline) {
    const d = deliberationStatusHandler({ deliberationId: stub.id });
    if (d.state !== lastState) {
      console.log(`  [${new Date().toISOString()}] → ${d.state} (round ${d.currentRound}, votes ${d.votes?.length ?? 0})`);
      lastState = d.state;
    }
    if (d.state === "SETTLED" || d.state === "ESCALATED" || d.state === "EXHAUSTED") {
      final = d;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!final) {
    console.error("\n[FAIL] timed out");
    process.exit(1);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[done] ${dt}s — state=${final.state} verdict=${final.verdict ?? "—"}`);

  // Read the rationale — was it a real vote or a timeout fallback?
  for (const v of final.votes ?? []) {
    const hex = v.rationaleHash.slice("sha256:".length);
    const blobPath = path.join(REPO, ".zana/artifacts/blobs", hex.slice(0, 2), hex.slice(2) + ".bin");
    let content = "(blob not found)";
    try { content = fs.readFileSync(blobPath, "utf8"); } catch {}
    const isTimeout = content.includes("[timeout]") || content.includes("[parse-fallback]") || content.includes("[spawn-error]");
    console.log(`\nvote: r${v.round} ${v.profileId} ${v.bit}`);
    console.log(`  raw output? ${isTimeout ? "FALLBACK (bad)" : "VOTER PRODUCED IT (good)"}`);
    console.log(`  rationale (first 600 chars):`);
    console.log("  " + content.slice(0, 600).replace(/\n/g, "\n  "));
  }

  // Tool-call budget check — count tool_use entries in the agent's outputBuffer.
  // Find the latest architect run.
  console.log(`\nvoter agent inspection:`);
  const runs = fs.readdirSync(path.join(REPO, ".zana/runs"));
  const candidates = [];
  for (const f of runs) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REPO, ".zana/runs", f), "utf8"));
      if (d.profileId === "architect" && d.spawnedAt > t0) {
        candidates.push({ f, d });
      }
    } catch {}
  }
  candidates.sort((a, b) => b.d.spawnedAt - a.d.spawnedAt);
  if (candidates.length > 0) {
    const { d } = candidates[0];
    const ob = d.outputBuffer || "";
    const toolUses = (ob.match(/"type":"tool_use","id":"[^"]+","name":"[^"]+"/g) || []).length;
    console.log(`  durationMs:    ${d.durationMs}`);
    console.log(`  exitCode:      ${d.exitCode}`);
    console.log(`  state:         ${d.state}`);
    console.log(`  output bytes:  ${ob.length}`);
    console.log(`  tool calls:    ${toolUses}  (budget: ≤5)`);
  }
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });
