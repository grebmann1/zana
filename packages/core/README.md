# @zana-ai/core

Foundational engine for [Zana](https://github.com/grebmann1/zana) — a
multi-agent orchestrator for Claude Code.

This package owns the cross-cutting primitives every other Zana package
builds on:

- **agents** — profile loading, lifecycle, headless spawn, hooks
- **events** — append-only event bus + replayable channels
- **project** — workspace-context singleton (tenant isolation)
- **modules** — pluggable capability registration
- **persistence** — content-addressed artifact store + checkpoints
- **daemon** — long-lived process entry point (`bin/daemon.ts`)
- **host** — process bootstrap, signal handling, IPC plumbing
- **guardrails** — policy gates shared across the runtime

## Install

```bash
npm install @zana-ai/core
```

## Public surface

```ts
import {
  agents,
  events,
  project,
  modules,
  persistence,
} from "@zana-ai/core";

project.workspaceContext.init(process.cwd());
const bus = events.bus;
```

The package uses **lazy require getters** in its facade to break what
would otherwise be circular dependencies between sibling packages.
Always import from the top-level entry, not from `dist/<subpath>`
directly.

## Workspace context — tenant isolation

Every project-local path (tickets, runs, checkpoints, scheduler,
events, artifacts) resolves through
`project.workspaceContext.getProjectPaths()`. Adding a new
project-local directory means adding it to BOTH the singleton branch
and the `createForWorkspace` factory in `project/workspace-context.ts`,
and consuming it via the workspace-context lookup — never by joining
paths from the workspace root in the calling module.

Tenant-isolated writes (CAS artifacts, `kind: "deliberation"`
checkpoints) **must refuse** the global `~/.zana/` fallback. Use
`WorkspaceNotInitializedError` to refuse rather than silently writing
to a host-shared directory.

## Build & test

```bash
npm run -w @zana-ai/core build
cd packages/core && npx vitest run
```

Built-in profiles ship under `packages/core/profiles/`; user profiles
live in `~/.zana/profiles/`.

## See also

- [`@zana-ai/work`](../work) — tickets, sprints, runs, deliberation
- [`@zana-ai/server`](../server) — HTTP/IPC surface
- [`@zana-ai/mcp`](../mcp) — MCP server exposing this engine to
  Claude Code
