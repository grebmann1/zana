# Installing Zana

Step-by-step install for humans and agents (Claude Code, Codex, Cursor, etc.).
Every step is an exact command — no prose-only instructions.

For background on what Zana is, see [README.md](./README.md).

---

## Prerequisites

| Tool | Min version | Check |
|---|---|---|
| Node.js | 20.x | `node -v` |
| npm | bundled with Node | `npm -v` |
| git | any recent | `git --version` |
| Claude Code CLI | optional but recommended | `claude --version` |

If `node -v` returns a version below 20, upgrade before continuing. The build
will fail otherwise.

---

## Path A — automated (recommended)

One command from inside the cloned repo:

```bash
git clone https://github.com/grebmann1/zana.git
cd zana
bash scripts/install.sh
```

Or remote-pipe (no clone):

```bash
curl -fsSL https://raw.githubusercontent.com/grebmann1/zana/main/scripts/install.sh | bash
```

The script handles: prereq checks, `npm install`, `npm run build:runtime`,
global CLI install, Claude MCP server registration (`zana` namespace, replaces
any legacy `hive` entry), `zana init wizard` for the workspace, and a final
`zana status` diagnostic.

Flags:

| Flag | Effect |
|---|---|
| `--workspace <path>` | Target workspace for `zana init wizard` (default: `$PWD`) |
| `--no-init` | Skip workspace initialization |
| `--no-setup-mcp` | Skip `claude mcp add` |
| `--no-doctor` | Skip post-install diagnostics |
| `--no-repair-mcp` | Don't pass `--repair-mcp` to init wizard |

The script does **not** install the slash-command plugins (`/zana`,
`/zana:autopilot`, etc.). After it finishes, run:

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install zana@zana-marketplace
claude plugin install zana-loop@zana-marketplace
# then restart Claude Code
```

Then jump to [Verification](#verification).

---

## Path B — manual (per-step, scriptable for agents)

Use this when the script fails, in CI without TTY, or when an agent needs to
verify each step itself.

### 1. Get the source

```bash
git clone https://github.com/grebmann1/zana.git
cd zana
```

### 2. Install dependencies

```bash
npm install
```

This installs the workspaces under `packages/` (core, work, server, mcp, swarm,
intelligence, extras).

### 3. Build runtime artifacts

```bash
npm run build:runtime
```

Compiles every package into its `dist/` directory and copies runtime assets
(profiles, modules) into `packages/core/dist/`. Re-run after pulling source
changes — Claude Code spawns `packages/mcp/dist/bin/zana-mcp-server.js`, not the
TypeScript source, so a stale `dist/` is the most common "it worked yesterday"
failure.

### 4. (Optional) Install the CLI globally

```bash
npm install -g .
```

This puts `zana` on `$PATH`. Without it, use `node dist/bin/zana.js <cmd>` from
inside the repo.

### 5. Register the Claude Code marketplace + plugin

This makes `/zana`, `/zana:council`, `/zana:autopilot`, etc. appear in your
slash-command picker.

```bash
claude plugin marketplace add /absolute/path/to/zana
claude plugin install zana@zana-marketplace
claude plugin install zana-loop@zana-marketplace
```

The marketplace name is `zana-marketplace` (declared in `.claude-plugin/marketplace.json`).
It exposes two plugins: `zana` (orchestrator + daemon-driven schedules) and
`zana-loop` (lightweight `/loop`-driven schedules — no daemon required).
After install, restart Claude Code so the new commands register.

Verify:

```bash
claude plugin details zana@zana-marketplace
# Skills count should be 23 (council family + autopilot/team/ticket/schedule/memory/status + collaboration/orchestration/zana).

claude plugin details zana-loop@zana-marketplace
# Skills count should be 4 (loop-start + loop-stop + loop-define + zana-scheduler).
```

### 6. Register the Zana MCP server

The MCP server is what Claude Code talks to over stdio when you invoke a
`mcp__zana__*` tool. Pick **one** scope:

```bash
# Local (per-project) — recommended for most users
claude mcp add -s local zana node /absolute/path/to/zana/packages/mcp/dist/bin/zana-mcp-server.js

# OR user-wide
claude mcp add -s user zana node /absolute/path/to/zana/packages/mcp/dist/bin/zana-mcp-server.js
```

Verify:

```bash
claude mcp list | grep zana
# Should print: zana: ... ✓ Connected
```

If you see `✗ Failed to connect`, run `npm run build:runtime:mcp` and retry.
The `dist/` is likely stale.

### 7. Initialize the workspace

```bash
node dist/bin/zana.js init wizard /absolute/path/to/your/workspace --repair-mcp
```

This creates `<workspace>/.zana/` (tickets, sprints, scheduler, sessions,
artifacts, etc.) and installs the post-tool-use hook wrapper at
`~/.zana/bin/post-hook.sh`.

### 8. Start the daemon

```bash
node dist/bin/zana.js headless /absolute/path/to/your/workspace --background
```

Note the positional argument convention: workspace path comes BEFORE flags.

The daemon listens on two ports:

- **Hook port** (default 47402) — Claude Code hooks POST events here.
- **API port** = hook port + 1 (default 47403) — bearer-token authenticated REST surface.

The registry record at `~/.zana/daemons/<id>.json` lists both:

```json
{ "id": "...", "port": 47402, "apiPort": 47403, "pid": ..., "workspace": "...", ... }
```

The auth token lives in `~/.zana/auth.json` and is used as `Authorization: Bearer <token>` on the API port.

### 9. Run diagnostics

```bash
node dist/bin/zana.js status          # show running daemons
node dist/bin/zana.js schedule list   # confirm scheduler loaded
node dist/bin/zana.js ticket list     # confirm tickets API responds
```

---

## Terminal CLI reference

After install, `zana` is on your PATH. Two binaries are exposed: `zana` (the
top-level dispatcher) and `zana-daemon` (the long-lived process).

### `zana` — top-level dispatcher

| Command | Effect | Needs daemon? |
|---|---|---|
| `zana --help` | Print help | no |
| `zana init [path]` | Create `.zana/` in a workspace | no |
| `zana init wizard [path] [--repair-mcp]` | Init + register MCP server | no |
| `zana migrate [path]` | Run pending schema migrations | no |
| `zana status` | List running daemons | no |
| `zana stop <id\|port>` / `zana stop --all` | Stop one or all daemons | no |
| `zana headless [path] [--background]` | Start daemon (foreground or fork) | no |
| `zana config list` / `config get <module>` / `config set <module> <key> <value>` | Inspect/modify module config | no (reads disk) |
| `zana ticket list [--status s] [--workspace p]` | List tickets | yes |
| `zana ticket rules list [--workspace p]` | List automation hook rules | yes |
| `zana run list [--limit N] [--workspace p]` | List recent agent runs | no (reads disk) |
| `zana schedule list [--json]` | List schedules in `.zana/scheduler/` | yes for live status |
| `zana schedule enable <id>` / `disable <id>` | Toggle one schedule | yes |
| `zana schedule enable-all` / `disable-all` | Toggle all schedules | yes |
| `zana schedule trigger <id>` | Fire a schedule once now | yes |
| `zana schedule reload` | Re-read YAMLs + re-arm triggers | yes |
| `zana schedule history <id> [-n N]` | Last N run entries (default 10) | yes |

Most commands accept `--workspace <path>` to target a specific project.

### `zana-daemon` — engine binary

You usually drive the daemon through `zana headless`, not directly. But these
subcommands are useful for ops:

| Command | Effect |
|---|---|
| `zana-daemon --help` | Daemon flags |
| `zana-daemon service install` / `uninstall` / `status` / `logs [n]` | Run/manage as a login service (launchd on macOS, systemd on Linux) |
| `zana-daemon plugin list` | List installed plugins |
| `zana-daemon plugin enable <id>` / `disable <id>` | Toggle a plugin |
| `zana-daemon plugin link <path>` / `unlink <id>` | Symlink a local plugin for development |
| `zana-daemon plugin init <name>` | Scaffold a new plugin |
| `zana-daemon config list` / `get <module>` / `set <module> <key> <value>` / `reset <module>` | Module configuration |

### `zana-mcp-server` — MCP transport

`zana-mcp-server` is what Claude Code launches over stdio. You don't run it
manually except for diagnostics:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}' \
  | zana-mcp-server | head -1
```

A successful handshake returns a `result` payload. If you see no output, the
build is stale — run `npm run build:runtime:mcp`.

---

## Verification

These commands should all succeed before you consider Zana installed:

```bash
# 1. Daemon is up
node /absolute/path/to/zana/dist/bin/zana.js status
# expected: ●  <id>  port:474XX  pid:<pid>  ...

# 2. MCP transport works (NDJSON handshake)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}' \
  | node /absolute/path/to/zana/packages/mcp/dist/bin/zana-mcp-server.js 2>/dev/null | head -1
# expected: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

# 3. Claude Code sees it
claude mcp list | grep zana
# expected: zana: ... ✓ Connected

# 4. Plugin registered
claude plugin details zana@zana-marketplace | head -5
# expected: zana / Multi-agent orchestrator / Skills (23)

# 5. Statusline emits new branding
echo '{"workspace":{"current_dir":"/absolute/path/to/your/workspace"}}' \
  | node /absolute/path/to/zana/packages/core/dist/bin/statusline.js
# expected starts with: ⚡ zana on (pid <n>) | ...
```

If any of these fail, see the next section.

---

## Common failure modes

### `claude mcp list` shows `✗ Failed to connect`

The `dist/` is stale, or the MCP server is using the wrong stdio framing
(LSP-style `Content-Length:` instead of newline-delimited JSON).

```bash
npm run build:runtime:mcp
claude mcp list | grep zana
```

If the rebuild doesn't fix it, the registration may be pointing at a path
that doesn't exist. Re-register:

```bash
claude mcp remove zana
claude mcp add -s local zana node /absolute/path/to/zana/packages/mcp/dist/bin/zana-mcp-server.js
```

### `/zana:autopilot` etc. don't appear in the slash-command picker

The plugin cache is stale. Reinstall:

```bash
claude plugin uninstall zana@zana-marketplace
claude plugin uninstall zana-loop@zana-marketplace
claude plugin install zana@zana-marketplace
claude plugin install zana-loop@zana-marketplace
# then restart Claude Code
```

### Port 47402 already in use

Another daemon is bound. Stop it:

```bash
node /absolute/path/to/zana/dist/bin/zana.js status      # find the id
node /absolute/path/to/zana/dist/bin/zana.js stop <id>   # or stop --all
```

### `zana-daemon: directory does not exist: /--port`

The `headless` subcommand parses positional arguments first. Put the workspace
path BEFORE any flag:

```bash
# WRONG — the bin parser eats `--port` as a directory
node dist/bin/zana.js headless --port 47400 --workspace /path/to/ws

# RIGHT
node dist/bin/zana.js headless /path/to/ws --background
```

### Statusline still shows `🐝 hive: ...`

Stale `packages/core/dist/bin/statusline.js`. Rebuild:

```bash
npm run build:runtime:core
```

### Hooks not firing (zero bytes in `<workspace>/.zana/sessions/<sid>/events.ndjson`)

The wrapper at `~/.zana/bin/post-hook.sh` may have drifted. Force-reinstall:

```bash
node -e 'require("@zana-ai/server").hooks.installer.installHooks(47402)'
```

---

## Uninstall

```bash
# Stop running daemons
node dist/bin/zana.js stop --all

# Remove plugins
claude plugin uninstall zana@zana-marketplace
claude plugin uninstall zana-loop@zana-marketplace
claude plugin marketplace remove zana-marketplace

# Remove MCP registration
claude mcp remove zana

# Remove CLI
npm uninstall -g zana

# (Optional) wipe state — irreversible
rm -rf ~/.zana
```

Workspace state under `<workspace>/.zana/` is left in place.

---

## For agents — minimal verification loop

If you're an agent installing Zana, run these in order, stopping at the first
failure:

```bash
set -e
node -v | grep -E '^v(2[0-9]|[3-9][0-9])\.' >/dev/null    # node >=20
npm -v >/dev/null
git --version >/dev/null
[ -f package.json ] && grep -q '"name": "zana"' package.json
npm install
npm run build:runtime
[ -f packages/mcp/dist/bin/zana-mcp-server.js ]
claude mcp add -s local zana node "$(pwd)/packages/mcp/dist/bin/zana-mcp-server.js" 2>&1 | head -1
claude mcp list 2>&1 | grep -q 'zana.* ✓ Connected'
claude plugin marketplace add "$(pwd)" 2>&1 | tail -1
claude plugin install zana@zana-marketplace
claude plugin install zana-loop@zana-marketplace
claude plugin details zana@zana-marketplace | grep -q 'Skills (23)'
claude plugin details zana-loop@zana-marketplace | grep -q 'Skills (4)'
node dist/bin/zana.js headless "$(pwd)" --background &
sleep 4
node dist/bin/zana.js status | grep -q '●'
echo "INSTALL OK"
```

A successful run prints `INSTALL OK` as the last line.
