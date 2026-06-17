// IProfileStore — the contract for the agent-profile library.
//
// Concrete impl: packages/core/src/agents/profile-store.ts (file-backed JSON in
// ~/.zana/profiles). Consumers (work/teams, intelligence/task-router, extras/
// skill-store, mcp) currently reach it via require("@zana-ai/core").agents
// .profileStore. Depending on this interface decouples them from that path and
// from core's internal module layout.
//
// Type-only module — no runtime code.

/**
 * An agent profile (role definition). Kept intentionally loose here — the rich
 * shape lives with the implementation and the MCP schema. `lens` is the
 * concern-tag used to roster deliberation voters; null/absent for util roles.
 */
export interface Profile {
  id: string;
  displayName?: string;
  description?: string;
  model?: string;
  lens?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  [key: string]: unknown;
}

export interface IProfileStore {
  listProfiles(): Profile[];
  getProfile(id: string): Profile | null;
  getProfilesByLens(lens: string): Profile[];
  saveProfile(profile: Profile): Profile;
  deleteProfile(id: string): boolean;
}
