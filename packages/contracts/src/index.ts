// @zana-ai/contracts — the dependency-free base layer.
//
// These modules used to live in @zana-ai/core and were loaded eagerly by every
// other package at module-init time, forming the load-time half of the
// core↔work↔extras require-cycle (ADR 0001). They depend on NOTHING (pure
// node:fs/path/os/events), so they belong in a true leaf package that everyone
// — including core — consumes. See ADR 0010.
//
// core re-exports each of these under its historical facade path
// (core.project.workspaceContext, core.config, core.events.bus, core.util.*)
// so existing `require("@zana-ai/core").x` / `_core().x` call sites are
// unchanged.

import * as workspaceContext from "./workspace-context";
import * as config from "./config";
import { bus, EVENTS } from "./bus";
import * as logger from "./logger";
import { lazyRequire } from "./lazy-require";

export { workspaceContext, config, bus, EVENTS, logger, lazyRequire };

// Also expose the named members callers reach for directly:
//   import { PERSIST_DIR, DAEMONS_DIR, ... } from "@zana-ai/contracts"
//   import { WorkspaceNotInitializedError } from "@zana-ai/contracts"
// config.ts is CommonJS (`module.exports = {...}`), so re-export its keys at
// the top level for the many `import { ZANA_DIR } from "../config"`-style call
// sites that now point here.
export * from "./config";
// Surface workspace-context's named members (init, getProjectPaths,
// createForWorkspace, isInitialized, WorkspaceNotInitializedError, …) at the
// top level so `import { createForWorkspace } from "@zana-ai/contracts"` works
// alongside the `import * as workspaceContext` (subpath) namespace style.
export * from "./workspace-context";

// Service contracts (type-only): the interfaces every package can depend on
// without depending on an implementation. See packages/contracts/src/services
// and docs/architecture-decoupling-plan.md.
export * from "./services";
