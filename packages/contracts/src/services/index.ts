// Service contracts — typed interfaces every package can depend on WITHOUT
// depending on an implementation. The concrete services (core/agents,
// work/tickets, …) implement these; MCP/HTTP adapters and cross-package callers
// consume them. All type-only — this barrel emits no runtime code.
//
// Roadmap (docs/architecture-decoupling-plan.md): Phase 1 defines these; Phase 2
// annotates the concrete services as implementations + injects them via a
// ServiceRegistry; Phase 3 retires the core god-façade re-exports.

export * from "./common";
export * from "./event-bus";
export * from "./profile-store";
export * from "./agent-manager";
export * from "./tickets";
