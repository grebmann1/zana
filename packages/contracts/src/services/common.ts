// Shared cross-service result + payload types.
//
// These live in @zana-ai/contracts (the dependency-free leaf) so every package
// can depend on the CONTRACT without depending on any implementation. Today the
// concrete services (work/tickets, core/agents, …) are reached via
// `require("@zana-ai/core")` + lazyRequire; these interfaces let callers depend
// on a typed shape instead of `any`, and let an implementation be swapped
// (in-process today, a remote/RPC adapter later) without touching call sites.
//
// Type-only module: it emits no runtime code, so importing it cannot widen the
// dependency graph or re-trigger a require-cycle.

/**
 * The uniform result shape Zana services return. Most service functions either
 * succeed with a payload or fail with a human-readable `error` string (they do
 * NOT throw for expected failures — invalid input, not-found, illegal
 * transition). `ServiceResult<T>` makes that contract explicit and checkable.
 */
export type ServiceError = { error: string };
export type ServiceOk<T> = { ok: true } & T;
export type ServiceResult<T> = ServiceOk<T> | ServiceError;

/** Narrowing helper — true when a ServiceResult is the error variant. */
export function isServiceError(r: unknown): r is ServiceError {
  return !!r && typeof r === "object" && "error" in (r as any) && typeof (r as any).error === "string";
}
