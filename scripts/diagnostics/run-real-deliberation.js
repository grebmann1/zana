#!/usr/bin/env node
// Real-Claude deliberation runner — spawns actual headless Claude agents
// to validate the council end-to-end.
//
// Verifies the May 2026 fix-bundle (commit 7535e78):
//   - 20-min default voter timeout (vs original 10 min that all 3 voters tripped)
//   - tightened buildVoterPrompt with worked examples + "end with JSON" tail
//   - async-by-default handler (returns deliberationId, polling for terminal)
//   - new zana_deliberate_cancel path (not exercised here but loaded)
//
// Cost: ~$3-5 per run (3 voters × 1 round × sonnet-4-6 ≈ $0.70 each).

const path = require("node:path");
const fs = require("node:fs");
const REPO = path.resolve(__dirname, "..", "..");

const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));

// CRITICAL: init workspace context BEFORE any deliberation code runs.
// Once initialized, the checkpoint store resolves its dir through workspace
// context and writes to <REPO>/.zana/checkpoints — calling
// checkpoint.store.init(REPO) here would mis-resolve to <REPO>/checkpoints.
core.project.workspaceContext.init(REPO);

const { deliberateHandler, deliberationStatusHandler } = require(
  path.join(REPO, "packages/mcp/dist/src/tools/deliberate.js"),
);

async function main() {
  const t0 = Date.now();
  const ts = new Date().toISOString();
  console.log(`[${ts}] starting real-Claude deliberation (async-by-default)...`);

  const stub = await deliberateHandler({
    question:
      "Zana's deliberation synthesis reducer (packages/work/src/deliberation/synthesize.ts) " +
      "is currently rule-based: keyword severity heuristic + Dice coefficient bullet grouping. " +
      "Should we keep rule-based for now (APPROVE) or migrate to LLM-based reduction in Sprint 3 (CHANGES)? " +
      "Weigh: determinism/replay-safety, cost-per-deliberation, auditability, and the governance guarantee " +
      "that dissent is preserved verbatim. Substantive rationale required.",
    voters: ["architect", "security-reviewer", "researcher"],
    rounds: 2,
    riskTag: "medium",
    // wait: false (default) — return immediately, then poll.
  });

  console.log(`\n[stub] state=${stub.state} _outcome=${stub._outcome}`);
  console.log(`[stub] deliberationId=${stub.id}`);

  // Poll until terminal. Generous overall budget — 30 min cap.
  const POLL_MS = 5000;
  const TIMEOUT_MS = 30 * 60 * 1000;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastState = "PROPOSED";
  let final;
  while (Date.now() < deadline) {
    const d = deliberationStatusHandler({ deliberationId: stub.id });
    if (d.state !== lastState) {
      console.log(`  [${new Date().toISOString()}] state → ${d.state} (round ${d.currentRound}/${d.rounds}, votes ${d.votes?.length ?? 0})`);
      lastState = d.state;
    }
    if (d.state === "SETTLED" || d.state === "ESCALATED" || d.state === "EXHAUSTED") {
      final = d;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!final) {
    console.error(`\n[FAIL] timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[${new Date().toISOString()}] complete in ${dt}s`);
  console.log("─".repeat(70));
  console.log(`state:        ${final.state}`);
  console.log(`verdict:      ${final.verdict ?? "—"}`);
  console.log(`escalation:   ${final.escalationReason ?? "—"}`);
  console.log(`rounds run:   currentRound=${final.currentRound} / cap=${final.rounds}`);
  console.log(`quorum:       ${final.quorum}`);
  console.log(`voters:       ${final.voters?.map((v) => `${v.profileId}@${v.modelId}`).join(", ")}`);

  console.log(`\nvotes (${final.votes?.length ?? 0}):`);
  for (const v of final.votes ?? []) {
    console.log(`  r${v.round} ${v.profileId.padEnd(20)} ${v.bit.padEnd(8)} ${v.rationaleHash.slice(0, 22)}…`);
  }

  console.log(`\ndissent (${final.dissent?.length ?? 0}):`);
  for (const d of final.dissent ?? []) {
    console.log(`  r${d.round} ${d.profileId.padEnd(20)} ${d.rationaleHash.slice(0, 22)}…`);
  }

  // Inspect each rationale artifact — verify voters actually produced
  // contract-compliant JSON this time.
  console.log("\nrationale samples (first 240 chars each):");
  const artifactDir = path.join(REPO, ".zana/artifacts/blobs");
  for (const v of final.votes ?? []) {
    const hex = v.rationaleHash.slice("sha256:".length);
    const blobPath = path.join(artifactDir, hex.slice(0, 2), hex.slice(2) + ".bin");
    let preview = "(blob not found)";
    try {
      const content = fs.readFileSync(blobPath, "utf8");
      preview = content.slice(0, 240).replace(/\s+/g, " ");
    } catch {}
    console.log(`  r${v.round} ${v.profileId} → ${preview}${preview.length >= 240 ? "…" : ""}`);
  }

  console.log(`\nsynthesisHash: ${final.synthesisHash ?? "—"}`);

  // Persist full record for inspection.
  const out = path.join(REPO, ".zana/last-deliberation.json");
  fs.writeFileSync(out, JSON.stringify(final, null, 2));
  console.log(`\nfull record: ${out}`);
}

main().catch((err) => {
  console.error("[CRASH]", err && err.stack ? err.stack : err);
  process.exit(1);
});
