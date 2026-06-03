# @zana-ai/swarm

Multi-daemon swarm coordination for
[Zana](https://github.com/grebmann1/zana) — router, events, spawner.

Headless / advanced primitive. Useful only when more than one Zana
daemon coordinates work across workspaces or hosts. For ordinary
single-daemon orchestration, the in-process agent tools in
[`@zana-ai/core`](../core) are sufficient.

## Install

```bash
npm install @zana-ai/swarm
```

## Modules

| File | What |
|---|---|
| `swarm/router.ts` | Cross-daemon task routing |
| `swarm/events.ts` | Cross-daemon event channels |
| `swarm/spawner.ts` | Sub-daemon lifecycle (spawn, supervise, reap) |

## Public surface

```ts
import { swarmRouter, swarmEvents, swarmSpawner } from "@zana-ai/swarm";
```

## Master mode

The companion `zana_swarm_*` MCP tools are gated behind
`ZANA_MASTER_MODE=true`. Set this only on the master daemon — sub-
daemons remain plain Zana daemons with no swarm tool surface.

## See also

- [`@zana-ai/core`](../core) — base agent runtime each sub-daemon runs
- [`@zana-ai/mcp`](../mcp) — MCP surface that exposes swarm tools when
  master mode is on
