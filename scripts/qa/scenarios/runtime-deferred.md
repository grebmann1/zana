# Zana runtime — DEFERRED scenarios (require API keys)

These scenarios exercise live agent runtimes. They make real API calls and
cost real money. **Do not run as part of the standard QA pass.** Run only
when the user explicitly provides API keys via env variables and asks for
runtime verification.

The scenarios below are scaffolds — they are not executed by Phase A/B/C.

---

## Scenario R1: Claude-spawn adapter — oneshot query (DEFERRED)

**Preconditions:**
- `ANTHROPIC_API_KEY` exported in env
- Repo built (`npm run build:runtime`)
- A daemon running for the repo workspace:
  ```bash
  node dist/bin/zana.js headless "$PWD" --background
  ```

**Command:**
```bash
ZANA_RUNTIME=claude-spawn \
node -e '
const path = require("path");
const REPO = process.cwd();
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
require(path.join(REPO, "packages/work/dist/src/index.js"));
try { core.project.workspaceContext.init(REPO); } catch {}

const { oneshotQueryHandler } = require(
  path.join(REPO, "packages/mcp/dist/src/tools/oneshot.js"),
);

(async () => {
  const result = await oneshotQueryHandler({
    profileId: "researcher",
    prompt: "Reply with the single word: PONG",
    timeoutMs: 60000,
  });
  console.log("RESULT:", JSON.stringify(result).slice(0, 400));
  if (!result || !result.output || !/PONG/i.test(result.output)) {
    console.error("FAIL — expected PONG in result.output");
    process.exit(1);
  }
  console.log("PASS");
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });
'
```

**Expected exit code:** 0
**Pass criteria:** stdout contains `PASS` and `RESULT:` line shows a
non-empty result containing "PONG" (case-insensitive).

**Cleanup:**
```bash
node dist/bin/zana.js stop --all
```

**Cost:** one short Claude call (sub-cent).

---

## Scenario R2: Real-Claude deliberation smoke (DEFERRED)

**Preconditions:** as R1.

**Command:**
```bash
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
ZANA_RUNTIME=claude-spawn \
node scripts/diagnostics/run-real-deliberation-snap.js
```

**Expected exit code:** 0
**Pass criteria:** script prints `All snap deliberation smoke tests passed.`
**Cost:** ~3 voter calls (a few cents); should complete in <90s with the
snap-judgment voter prompt.

**Cleanup:**
```bash
node dist/bin/zana.js stop --all
rm -rf .zana/checkpoints/deliberation-*
```

---

## Scenario R3: Vercel AI adapter — oneshot via OpenAI (DEFERRED)

**Preconditions:**
- `OPENAI_API_KEY` exported in env (the vercel-ai adapter currently routes
  through OpenAI by default — confirm with adapter source if updated)
- Repo built
- Daemon running (as R1)

**Command:**
```bash
OPENAI_API_KEY=$OPENAI_API_KEY \
ZANA_RUNTIME=vercel-ai \
node -e '
const path = require("path");
const REPO = process.cwd();
const core = require(path.join(REPO, "packages/core/dist/src/index.js"));
require(path.join(REPO, "packages/work/dist/src/index.js"));
try { core.project.workspaceContext.init(REPO); } catch {}

const { oneshotQueryHandler } = require(
  path.join(REPO, "packages/mcp/dist/src/tools/oneshot.js"),
);

(async () => {
  const result = await oneshotQueryHandler({
    profileId: "researcher",
    prompt: "Reply with the single word: PONG",
    timeoutMs: 60000,
  });
  console.log("RESULT:", JSON.stringify(result).slice(0, 400));
  if (!result || !result.output || !/PONG/i.test(result.output)) {
    console.error("FAIL — expected PONG in result.output");
    process.exit(1);
  }
  console.log("PASS (vercel-ai adapter)");
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });
'
```

**Expected exit code:** 0
**Pass criteria:** stdout contains `PASS (vercel-ai adapter)`.
**Cost:** one short OpenAI call (sub-cent).

**Cleanup:**
```bash
node dist/bin/zana.js stop --all
```

---

## Skip messages (when keys absent)

If `ANTHROPIC_API_KEY` is unset:
```
SKIP R1, R2 — set ANTHROPIC_API_KEY to enable
```

If `OPENAI_API_KEY` is unset:
```
SKIP R3 — set OPENAI_API_KEY to enable
```

## How to run all three at once

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
bash scripts/qa/run-runtime.sh   # writes results/runtime.txt
```

`scripts/qa/run-runtime.sh` is intentionally not authored yet — author it
when the user provides keys, so the runner is built against the actual
environment rather than guessed.
