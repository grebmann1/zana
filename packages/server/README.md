# @zana-ai/server — HTTP surfaces

Zana exposes two HTTP servers from a single daemon process. They serve
different callers, have different trust models, and should never be
confused when adding new endpoints.

## Two servers, two purposes

### hook-server (default port 47400)

- **Caller**: spawned Claude agents on the same host, via
  `packages/server/src/hooks/wrapper.sh`.
- **Binds**: `127.0.0.1` only.
- **Auth**: none. Trust is based on loopback + same-user process boundary.
- **Purpose**: agent-lifecycle callbacks — hook events (PreToolUse,
  Stop, SessionEnd), inbox delivery between agents, swarm sub-daemon
  fan-in, ticket/sprint/scheduler back-compat shims.
- **Source**: `src/hooks/server.ts`.

### api-server (default port 47401, i.e. hook port + 1)

- **Caller**: humans, via the `zana` CLI and the (planned) viewer UI.
- **Binds**: `127.0.0.1` only.
- **Auth**: bearer token, validated by `src/api/auth-middleware.ts`.
  Token lives in `~/.zana/auth.json` mode 0600, generated on first
  daemon boot.
- **Purpose**: read/write workspace state, stream events via SSE,
  drive the orchestrator from external clients.
- **Source**: `src/api/server.ts`.

## Which server should new endpoints go on?

Decision tree:

1. Called by spawned Claude agents during their lifecycle?
   → **hook-server**.
2. Called by humans via CLI/UI?
   → **api-server** (must require auth).
3. Called by both?
   → **api-server**. If a hook ever needs the same data, have the
   hook callback into api-server internally rather than duplicating
   the route.

## Known overlap

These routes exist on **both** servers today for back-compat with
older `wrapper.sh` integrations:

- `/tickets`, `/tickets/*`
- `/sprints`, `/sprints/*`
- `/scheduler`, `/scheduler/*`
- `/swarm/agents`
- `/orchestrator`

New consumers should target the api-server versions. The hook-server
copies are frozen — do not extend them.

## Threat model

### hook-server

- Trusts any process running as the same user on the same host.
  A malicious local process gains full hook-server access if it can
  open a TCP connection to loopback.
- Mitigations: localhost-only bind, no DNS resolution, no internet
  egress, body size cap (256 KB), per-handler 30 s timeout, agentId
  format validation on `/swarm/inbox`.
- **Not** intended for network exposure. Do not bind to `0.0.0.0`.

### api-server

- Bearer token required on every request. Token is 256-bit random,
  stored at `~/.zana/auth.json` with mode 0600.
- Same localhost-only bind, same body-size and timeout protections.
- **Not** intended for network exposure either — the bearer token is
  a defense-in-depth measure against same-host malicious processes,
  not a substitute for transport security.

Neither server should ever be reverse-proxied to the public internet.

## Explicitly deferred (do not re-open without a design decision)

The 3-architect review on 2026-05-19 identified these and **chose to
defer**, not because we forgot. Don't waste a cycle re-discovering them.

### Hook-server auth

Adding bearer auth to the hook-server has known costs:

- `wrapper.sh` would need to read `~/.zana/auth.json` and inject
  `Authorization: Bearer <token>` on every curl. Today the wrapper is
  intentionally credential-free.
- Spawned agents would need either filesystem access to the token
  (already true: same user), or an env var injected at spawn time
  (`ZANA_HOOK_TOKEN`). The injection plumbing crosses
  `agents/spawner.ts`, the agent process bootstrap, and any
  subprocesses the agent itself spawns.
- The token alone doesn't change the threat model — same-user processes
  can still read the token from disk. The real protection is "we trust
  same-user same-host processes". Adding auth without changing that
  trust model is theatre.

**Decision:** keep deferred until we have an explicit threat model
that requires same-user mistrust (e.g. shared workstations, untrusted
local browser extensions, etc.).

### Endpoint deduplication

The "Known overlap" routes above are duplicated across both servers
for back-compat. Removing the hook-server copies would mean either:

- Forcing hook callers (wrapper.sh, agents) to authenticate to the
  api-server (see "Hook-server auth" above for why that's deferred), or
- Adding a "loopback bypass" to the api-server's auth middleware,
  which weakens the api-server contract.

**Decision:** keep deferred. The duplicated routes are stable, tested,
and not extended. Net cost of the duplication today is documentation
overhead, not maintenance pain.

## Common patterns

- Route definitions: `src/hooks/server.ts` (hook) and
  `src/api/server.ts` (api).
- Hook wrapper script (called by Claude Code hook config):
  `src/hooks/wrapper.sh`.
- Auth middleware: `src/api/auth-middleware.ts`.
- SSE event broadcasting (api-server only): `src/api/sse-broadcaster.ts`.

## Hook event flow (end-to-end)

```
Claude Code session
        │
        │  (PreToolUse, PostToolUse, Stop, SessionEnd, …)
        ▼
~/.claude/settings.json  ────►  bash ~/.zana/bin/post-hook.sh
                                       │
                                       │ jq-injects ZANA_TERMINAL_ID
                                       │ reads ~/.zana/daemons/*.json
                                       │ caps fan-out at 10
                                       ▼
                            POST http://127.0.0.1:<port>/hook
                            (every running daemon, in parallel)
                                       │
                                       ▼
                            hook-server.onHook(payload)
                            ├─► agentManager.updateAgentFromHook
                            └─► eventLog.append(payload)
                                       │
                                       ▼
              .zana/sessions/<sid>/events.ndjson    (global stream)
              .zana/sessions/<sid>/agents/<tid>.ndjson (per-agent)
              .zana/audit/audit.ndjson  (Stop / SessionEnd only)
```

### `wrapper.sh` contract

`src/hooks/wrapper.sh` is the user-side relay. It is deployed to
`~/.zana/bin/post-hook.sh` by `installer.installHooks()`. **Properties:**

- **stdin** = the raw Claude Code hook payload (JSON).
- **`ZANA_TERMINAL_ID`** env var (when set) is injected into the payload's
  `zana_terminal_id` field via `jq --arg` (handles slashes, quotes, etc.).
  Falls back to no injection if `jq` is missing.
- **Fan-out cap** at 10 daemons. Stale registry entries beyond the cap
  trigger a one-line stderr warning recommending `zana stop --all`.
- **Per-curl timeout** of 0.4s — never blocks Claude Code if a daemon hangs.
- **Always exits 0** — hook failures must not break the user's session.

### `installer` lifecycle

`packages/server/src/hooks/installer.ts` exposes:

- `installHooks(port)` — deploys `wrapper.sh` to `~/.zana/bin/post-hook.sh`,
  registers the script for all 7 lifecycle events in `~/.claude/settings.json`,
  and backs up the original settings to `~/.claude/settings.json.bak.zana`
  (once, the first time we touch it).
- `uninstallHooks()` — removes our entries; preserves any user hooks for
  the same events.
- `isHooksInstalled()` — returns true only when **both** are true:
  1. settings.json has at least one of our hook entries, AND
  2. the on-disk wrapper byte-matches the bundled `wrapper.sh`.
  The second check catches **wrapper drift** — older Zana versions
  installed a pre-hardening wrapper that pointed at the legacy
  `~/.zana/hives` registry and used unsafe `sed` injection. Without the
  byte check, the upgrade gate in `core.ts` would never re-deploy.
- `installMcpServer(port)` / `uninstallMcpServer()` / `isMcpInstalled()`
  for the `mcpServers.zana` entry.

The daemon auto-runs both installers on startup if their `is*Installed()`
return false. Test coverage: `test/integration/hook-installer.test.ts`
(8 cases covering fresh install, idempotency, drift detection,
user-hook preservation on uninstall).

### Audit log shape

`~/.zana/audit/audit.ndjson` (per-user, append-only) and
`<workspace>/.zana/audit/audit.ndjson` (per-workspace) capture lifecycle
events. Both rotate at 250 MB by default (`ZANA_AUDIT_LOG_MAX_BYTES`).

| event                | trigger                            | fields                                            |
|---------------------|------------------------------------|---------------------------------------------------|
| `session_start`     | `eventLog.init()`                  | `sessionId`, `workspace`                          |
| `agent_spawned`     | `POST /orchestrator spawn_agent`   | `agentId`, `profileId`, `workspace`               |
| `agent_killed`      | `POST /orchestrator kill_agent`    | `agentId`, `workspace`                            |
| `agent_completed`   | hook `Stop` or `SessionEnd`        | `agentId`, `hookEvent`, `result` (stop_reason)    |

### Troubleshooting

- **Hooks aren't firing** — check `shasum -a 256 ~/.zana/bin/post-hook.sh`
  and compare to `packages/server/src/hooks/wrapper.sh`. If they differ,
  restart the daemon (it'll re-deploy via the drift detector).
- **Events not landing in workspace** — confirm the wrapper points at
  `~/.zana/daemons/`, not the legacy `~/.zana/hives/`. Older installs
  had a stale wrapper.
- **Fan-out warnings** — `zana stop --all` clears stale registry files.
