# @zana/server — HTTP surfaces

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

## Common patterns

- Route definitions: `src/hooks/server.ts` (hook) and
  `src/api/server.ts` (api).
- Hook wrapper script (called by Claude Code hook config):
  `src/hooks/wrapper.sh`.
- Auth middleware: `src/api/auth-middleware.ts`.
- SSE event broadcasting (api-server only): `src/api/sse-broadcaster.ts`.
