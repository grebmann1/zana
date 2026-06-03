# @zana-ai/intelligence

Intelligence layer for [Zana](https://github.com/grebmann1/zana) —
task router, GOAP planner, vector memory, and background workers.

These primitives sit one level above raw agent spawning: they decide
*which* agent to use, *what* to plan next, and run long-lived
background loops that observe and act on workspace state.

## Install

```bash
npm install @zana-ai/intelligence
```

## Modules

| File | What |
|---|---|
| `task-router.ts` | Chooses the best profile for an incoming task — used by `/zana` and `zana_route_task` |
| `goap-planner.ts` | Goal-Oriented Action Planning — backs `/zana:autopilot` |
| `vector-memory.ts` | Embeddings-backed fuzzy K/V (`zana_memory_store` / `zana_memory_search`) |
| `background-workers.ts` | Daemon-managed background loops |

## Public surface

```ts
import {
  taskRouter,
  goapPlanner,
  vectorMemory,
  backgroundWorkers,
} from "@zana-ai/intelligence";
```

## See also

- [`@zana-ai/core`](../core) — the engine this layer composes on
- [`@zana-ai/work`](../work) — autopilot goal store + run history
