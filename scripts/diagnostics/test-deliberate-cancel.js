#!/usr/bin/env node
// Smoke test for zana_deliberate_cancel against the built artifacts.
// Verifies: kick off async deliberation with slow voters → cancel mid-flight
// → kills voter agents → lands EXHAUSTED/ESCALATED.

const path = require("node:path");
const REPO = path.resolve(__dirname, "..", "..");

const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
require(path.join(REPO, "packages/work/dist/src/index.js"));

try { core.project.workspaceContext.init(REPO); } catch {}

const { deliberateHandler, deliberationStatusHandler, deliberationCancelHandler } = require(
  path.join(REPO, "packages/mcp/dist/src/tools/deliberate.js"),
);

function profileFor(id) {
  return { id, displayName: id, model: "claude-sonnet-4-6" };
}

function fakeProbe() {
  return async (profile) => ({
    ok: true, latencyMs: 1, failures: [], modelId: profile.model,
    probeId: `p-${profile.id}`, legs: [],
  });
}

function slowAgents() {
  let id = 0;
  const agents = new Map();
  return {
    spawnHeadlessAgent: (profile) => {
      const aid = `slow-${profile.id}-${++id}`;
      agents.set(aid, { id: aid, profileId: profile.id, state: "running", outputBuffer: "" });
      return { agentId: aid };
    },
    getAgent: (aid) => agents.get(aid) ?? null,
    killAgent: (aid) => {
      const a = agents.get(aid);
      if (a) {
        a.state = "terminated";
        a.result = '{"bit":"CHANGES","rationale":"[killed]"}';
        a.outputBuffer = a.result;
      }
      return true;
    },
  };
}

(async () => {
  const pair = slowAgents();
  const deps = {
    probeAgent: fakeProbe(),
    spawnHeadlessAgent: pair.spawnHeadlessAgent,
    getAgent: pair.getAgent,
    killAgent: pair.killAgent,
    getProfile: (id) => profileFor(id),
    pollIntervalMs: 5,
    timeoutMs: 60000,
    maxIterations: 32,
  };

  console.log("[1] Kick off async deliberation with slow voters");
  const stub = await deliberateHandler({
    question: "Cancel smoke test",
    voters: ["a", "b", "c"],
    rounds: 1,
    deps,
  });
  console.log(`    state=${stub.state} id=${stub.id.slice(0, 8)}…`);
  if (stub.state !== "PROPOSED") { console.error("FAIL"); process.exit(1); }

  // Give the runner a beat to enter assemble + spawn.
  await new Promise((r) => setTimeout(r, 50));

  console.log("\n[2] Cancel mid-flight");
  const cancelResult = deliberationCancelHandler({ deliberationId: stub.id });
  console.log(`    _outcome=${cancelResult._outcome} _killedAgents=${cancelResult._killedAgents}`);
  if (cancelResult._outcome !== "cancelling") { console.error("FAIL"); process.exit(1); }

  console.log("\n[3] Poll for terminal state");
  let final;
  for (let i = 0; i < 200; i++) {
    const s = deliberationStatusHandler({ deliberationId: stub.id });
    if (s.state === "EXHAUSTED" || s.state === "SETTLED" || s.state === "ESCALATED") {
      final = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log(`    final state=${final?.state}`);
  if (!["EXHAUSTED", "ESCALATED"].includes(final?.state)) { console.error("FAIL"); process.exit(1); }

  console.log("\n[4] Re-cancel an already-terminal deliberation → no-op");
  const reCancel = deliberationCancelHandler({ deliberationId: stub.id });
  console.log(`    _outcome=${reCancel._outcome} _alreadyTerminal=${reCancel._alreadyTerminal}`);
  if (!reCancel._alreadyTerminal) { console.error("FAIL"); process.exit(1); }

  console.log("\nAll cancel smoke tests passed.");
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });
