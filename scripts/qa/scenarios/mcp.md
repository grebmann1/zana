# MCP Server — QA Scenarios

Surface under test: `zana-mcp-server` stdio JSON-RPC.

**Entry:** `node packages/mcp/dist/bin/zana-mcp-server.js`
**Transport:** newline-delimited JSON (NDJSON) over stdin/stdout.
**Canonical handshake:** `INSTALL.md` § Verification step 2.

All scenarios assume CWD is the repo root: `/Users/grebmann/Documents/claude-workspace/zana`.

Run any one scenario by copying the bash block. Each block is self-contained
and exits 0 on PASS, non-zero on FAIL. Do NOT execute as part of authoring —
this file is a runnable spec, not a test runner.

---

### Scenario 1: MCP initialize handshake
**Preconditions:** built dist (`packages/mcp/dist/bin/zana-mcp-server.js` exists).
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana
test -f packages/mcp/dist/bin/zana-mcp-server.js || { echo "FAIL: dist not built"; exit 1; }

LINE=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}' \
  | node packages/mcp/dist/bin/zana-mcp-server.js 2>/dev/null | head -1)

[ -z "$LINE" ] && { echo "FAIL: no stdout"; exit 1; }

node -e '
const s = process.argv[1];
let m;
try { m = JSON.parse(s); } catch (e) { console.error("FAIL: not JSON:", e.message); process.exit(1); }
if (!m.result) { console.error("FAIL: no result field"); process.exit(1); }
if (!m.result.serverInfo || m.result.serverInfo.name !== "zana") {
  console.error("FAIL: serverInfo.name is not zana, got:", JSON.stringify(m.result.serverInfo));
  process.exit(1);
}
console.log("PASS");
' "$LINE"
```
**Expected exit code:** 0
**Pass criteria:** First stdout line parses as JSON-RPC and contains `result.serverInfo.name === "zana"`.
**Cleanup:** none (server exits when stdin closes).

---

### Scenario 2: tools/list returns ≥80 tools
**Preconditions:** built dist exists.
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana

node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["packages/mcp/dist/bin/zana-mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });

p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa", version: "0" } } }) + "\n");

let buf = "";
let initSeen = false;
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id === 1 && msg.result && !initSeen) {
      initSeen = true;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    } else if (msg.id === 2 && msg.result) {
      const n = (msg.result.tools || []).length;
      if (n >= 80) { console.log("PASS: tools.length =", n); p.kill(); process.exit(0); }
      console.error("FAIL: tools.length =", n, "expected >= 80");
      p.kill();
      process.exit(1);
    }
  }
});
setTimeout(() => { console.error("FAIL: timeout"); p.kill(); process.exit(1); }, 15000);
'
```
**Expected exit code:** 0
**Pass criteria:** `result.tools.length >= 80` for the `tools/list` response.
**Cleanup:** none (script kills the child).

---

### Scenario 3: tools/list contents include core zana_* tools
**Preconditions:** built dist exists.
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana

node -e '
const { spawn } = require("child_process");
const REQUIRED = ["zana_list_profiles", "zana_ticket_list", "zana_schedule_list", "zana_deliberate", "zana_spawn_agent"];
const p = spawn("node", ["packages/mcp/dist/bin/zana-mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });

p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa", version: "0" } } }) + "\n");

let buf = "";
let initSeen = false;
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id === 1 && msg.result && !initSeen) {
      initSeen = true;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    } else if (msg.id === 2 && msg.result) {
      const names = new Set((msg.result.tools || []).map((t) => t.name));
      const missing = REQUIRED.filter((n) => !names.has(n));
      if (missing.length === 0) { console.log("PASS: all required tools present"); p.kill(); process.exit(0); }
      console.error("FAIL: missing tools:", missing.join(", "));
      p.kill();
      process.exit(1);
    }
  }
});
setTimeout(() => { console.error("FAIL: timeout"); p.kill(); process.exit(1); }, 15000);
'
```
**Expected exit code:** 0
**Pass criteria:** `tools/list` response contains all of `zana_list_profiles`, `zana_ticket_list`, `zana_schedule_list`, `zana_deliberate`, `zana_spawn_agent`.
**Cleanup:** none.

---

### Scenario 4: Read-only tool call — `zana_list_profiles`
**Preconditions:** built dist exists. 14+ built-in profiles ship under `packages/core/profiles/`.
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana

node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["packages/mcp/dist/bin/zana-mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });

p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa", version: "0" } } }) + "\n");

let buf = "";
let initSeen = false;
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id === 1 && msg.result && !initSeen) {
      initSeen = true;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "zana_list_profiles", arguments: {} } }) + "\n");
    } else if (msg.id === 2) {
      if (msg.error) { console.error("FAIL: tool returned error:", JSON.stringify(msg.error)); p.kill(); process.exit(1); }
      if (!msg.result) { console.error("FAIL: no result"); p.kill(); process.exit(1); }
      const content = msg.result.content;
      if (!Array.isArray(content) || content.length === 0) { console.error("FAIL: empty content"); p.kill(); process.exit(1); }
      const text = content.map((c) => c.text || "").join("");
      if (!text || text.length < 10) { console.error("FAIL: result text too short:", text); p.kill(); process.exit(1); }
      console.log("PASS: zana_list_profiles returned", text.length, "chars");
      p.kill();
      process.exit(0);
    }
  }
});
setTimeout(() => { console.error("FAIL: timeout"); p.kill(); process.exit(1); }, 20000);
'
```
**Expected exit code:** 0
**Pass criteria:** `tools/call` for `zana_list_profiles` returns a non-error `result.content` array with at least one non-empty text block.
**Cleanup:** none.

---

### Scenario 5: Invalid JSON-RPC method returns error
**Preconditions:** built dist exists.
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana

node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["packages/mcp/dist/bin/zana-mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });

p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa", version: "0" } } }) + "\n");

let buf = "";
let initSeen = false;
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id === 1 && msg.result && !initSeen) {
      initSeen = true;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "foo/bar", params: {} }) + "\n");
    } else if (msg.id === 99) {
      if (msg.error && typeof msg.error.code !== "undefined") {
        console.log("PASS: error response code =", msg.error.code, "message =", msg.error.message);
        p.kill();
        process.exit(0);
      }
      console.error("FAIL: expected error response, got:", JSON.stringify(msg));
      p.kill();
      process.exit(1);
    }
  }
});
setTimeout(() => { console.error("FAIL: timeout"); p.kill(); process.exit(1); }, 10000);
'
```
**Expected exit code:** 0
**Pass criteria:** Server replies to id=99 with a JSON-RPC `error` object containing a numeric `code`.
**Cleanup:** none.

---

### Scenario 6: Malformed JSON input does not crash session
**Preconditions:** built dist exists.
**Command:**
```bash
cd /Users/grebmann/Documents/claude-workspace/zana

node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["packages/mcp/dist/bin/zana-mcp-server.js"], { stdio: ["pipe", "pipe", "inherit"] });

let exited = false;
p.on("exit", (code) => { exited = true; });

p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa", version: "0" } } }) + "\n");

let buf = "";
let phase = 0; // 0: waiting init, 1: garbage sent, 2: post-garbage init result confirmed
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id === 1 && msg.result && phase === 0) {
      phase = 1;
      // Complete the MCP handshake first (server requires initialized
      // notification before non-init requests), then send a corrupted
      // line + a valid follow-up.
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      p.stdin.write("{this is not valid json}}}\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    } else if (msg.id === 2) {
      // Server survived garbage and answered the next valid request.
      if (msg.result || msg.error) {
        console.log("PASS: server survived malformed line and responded to follow-up id=2");
        p.kill();
        process.exit(0);
      }
    }
  }
});

setTimeout(() => {
  if (exited) { console.error("FAIL: server crashed after malformed input"); process.exit(1); }
  console.error("FAIL: timeout waiting for follow-up response");
  p.kill();
  process.exit(1);
}, 15000);
'
```
**Expected exit code:** 0
**Pass criteria:** After receiving a malformed JSON line, the server still answers a valid follow-up `tools/list` request (i.e. it errored on or skipped the bad line without crashing the session).
**Cleanup:** none.

---

### Scenario 7: `claude mcp list | grep zana` (CONDITIONAL)
**Preconditions:** `claude` CLI is on `PATH` and Zana has been registered as an MCP server in Claude Code. If `claude` is not present, this scenario is **CONDITIONAL — SKIP** (mark as N/A in the run report; do not fail).
**Command:**
```bash
if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP (CONDITIONAL): claude CLI not on PATH"
  exit 0
fi

OUT=$(claude mcp list 2>/dev/null | grep -E '^zana[: ]' || true)
if [ -z "$OUT" ]; then
  echo "FAIL: 'zana' entry missing from 'claude mcp list'"
  exit 1
fi

echo "$OUT" | grep -q "Connected" || {
  echo "FAIL: zana entry not Connected:"
  echo "$OUT"
  exit 1
}

echo "PASS: $OUT"
```
**Expected exit code:** 0 (PASS or documented SKIP).
**Pass criteria:** `claude mcp list` output includes a `zana:` line showing `Connected`. If `claude` is not installed, the scenario is skipped.
**Cleanup:** none.

---

## Notes for the runner

- Scenarios 1–6 are unconditional and require only `node` plus a built `packages/mcp/dist/`.
- Scenario 7 is environment-dependent (Claude Code CLI installed and Zana registered).
- All scenarios close the server by killing the child or by closing stdin; none leave background state under `.zana/`.
- The canonical handshake mirrored here matches `INSTALL.md` § Verification step 2 — keep them in sync if either changes.
