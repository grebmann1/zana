#!/usr/bin/env node
// Smoke-test the new async-by-default zana_deliberate handler against the
// live daemon's @zana/work + @zana/core. Doesn't actually spawn real Claude
// — uses the deliberation handler with a fake spawn for speed.

const path = require("node:path");
const REPO = path.resolve(__dirname, "..", "..");

const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
const work = require(path.join(REPO, "packages/work/dist/src/index.js"));

try { core.project.workspaceContext.init(REPO); } catch {}
try { work.runs.checkpoint.store.init(REPO); } catch {}

const { deliberateHandler, deliberationStatusHandler } = require(
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

function fakeAgentPair(script) {
  let nextId = 0;
  const agents = new Map();
  return {
    spawnHeadlessAgent: (profile) => {
      const id = `fake-${profile.id}-${++nextId}`;
      const cell = script[profile.id];
      const result = JSON.stringify(cell);
      agents.set(id, { id, profileId: profile.id, state: "terminated", result, outputBuffer: result });
      return { agentId: id, terminalId: `t-${id}` };
    },
    getAgent: (id) => agents.get(id) ?? null,
    killAgent: (id) => agents.delete(id),
  };
}

(async () => {
  const pair = fakeAgentPair({
    a: { bit: "APPROVE", rationale: "ok" },
    b: { bit: "APPROVE", rationale: "ok" },
    c: { bit: "APPROVE", rationale: "ok" },
  });
  const deps = {
    probeAgent: fakeProbe(),
    spawnHeadlessAgent: pair.spawnHeadlessAgent,
    getAgent: pair.getAgent,
    killAgent: pair.killAgent,
    getProfile: (id) => profileFor(id),
    pollIntervalMs: 1,
    timeoutMs: 5000,
    maxIterations: 32,
  };

  console.log("[1] Default (async): expect immediate return with PROPOSED + _async=true");
  const t0 = Date.now();
  const stub = await deliberateHandler({
    question: "Async smoke test",
    voters: ["a", "b", "c"],
    rounds: 1,
    deps,
  });
  const dt = Date.now() - t0;
  console.log(`    returned in ${dt}ms`);
  console.log(`    state=${stub.state} _async=${stub._async} _outcome=${stub._outcome}`);
  if (stub.state !== "PROPOSED" || !stub._async) {
    console.error("    FAIL");
    process.exit(1);
  }
  console.log("    OK");

  console.log("\n[2] Poll status until terminal");
  let final;
  for (let i = 0; i < 100; i++) {
    const s = deliberationStatusHandler({ deliberationId: stub.id });
    if (s.state === "SETTLED" || s.state === "ESCALATED") {
      final = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`    final state=${final?.state} verdict=${final?.verdict} votes=${final?.votes?.length}`);
  if (final?.state !== "SETTLED" || final?.verdict !== "approve") {
    console.error("    FAIL — expected SETTLED/approve");
    process.exit(1);
  }
  console.log("    OK");

  console.log("\n[3] wait=true (legacy): expect blocking + final record");
  const t1 = Date.now();
  const blocking = await deliberateHandler({
    question: "Wait-true smoke test",
    voters: ["a", "b", "c"],
    rounds: 1,
    wait: true,
    deps,
  });
  const dt1 = Date.now() - t1;
  console.log(`    returned in ${dt1}ms`);
  console.log(`    state=${blocking.state} _outcome=${blocking._outcome} _async=${blocking._async}`);
  if (blocking.state !== "SETTLED" || blocking._async !== undefined) {
    console.error("    FAIL");
    process.exit(1);
  }
  console.log("    OK");

  console.log("\nAll smoke tests passed.");
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });
