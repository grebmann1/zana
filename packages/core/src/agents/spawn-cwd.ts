/**
 * spawn-cwd.ts — resolve and CONFINE the working directory a spawned agent
 * runs in.
 *
 * Two callers need the exact same rule and must not drift:
 *   - the in-process dispatcher (agents/dispatch.ts spawn_agent / _validated /
 *     spawn_oneshot), reached by an MCP client / a nested spawned agent;
 *   - the HTTP API (server.ts POST /agents), reached by a co-workspace daemon
 *     forward (ADR 0006).
 *
 * Before this helper the dispatcher hardcoded `cwd = getWorkspaceFn()` with no
 * caller override (so workers always ran in the daemon workspace), and the HTTP
 * path had its own ad-hoc `resolved.startsWith(workspace)` check. This unifies
 * both: an OPTIONAL caller-supplied `cwd` / `projectId`, always confined.
 *
 * Confinement rule (deny by default):
 *   - `projectId` → resolved to a REGISTERED project's root (must exist in
 *     ~/.zana/projects.json). A bare projectId is the safe way to target another
 *     workspace: the caller can't point at an arbitrary path, only at a project
 *     a human already registered.
 *   - `cwd` → realpath-resolved (following symlinks) and required to sit inside
 *     the confinement root (the registered project root when projectId is given,
 *     otherwise the daemon workspace). realpath closes the `workspace/../../etc`
 *     and symlink-escape holes a plain string-prefix check leaves open.
 *   - neither → the confinement root itself (workspace), preserving today's
 *     default behaviour.
 *
 * Returns `{ cwd }` on success or `{ error }` on a confinement violation /
 * unknown project. Pure except for the registry read + realpath stat, so it is
 * unit-testable with a tmp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as projectRegistry from "../project/registry";

export interface ResolveConfinedCwdInput {
  /** Optional caller-supplied working directory. Confined to the root. */
  cwd?: string | null;
  /** Optional registered-project id. Targets that project's root as the confinement root. */
  projectId?: string | null;
  /** The default confinement root (the daemon/session workspace). */
  workspace: string;
}

export type ResolveConfinedCwdResult = { cwd: string } | { error: string };

// realpath if the path exists; otherwise fall back to a logical resolve so a
// not-yet-created dir still gets normalized (.. collapsed) for the prefix test.
// A symlink that resolves OUTSIDE the root is caught because realpathSync
// follows it before we compare.
function canonicalize(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// True when `child` is the root itself or genuinely nested under it. Compares
// canonicalized paths with a trailing separator so `/ws-evil` is not accepted
// as inside `/ws`.
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

export function resolveConfinedCwd(input: ResolveConfinedCwdInput): ResolveConfinedCwdResult {
  const { cwd, projectId, workspace } = input;

  // Establish the confinement root. A projectId names a DIFFERENT registered
  // workspace; without one we confine to the caller's own workspace.
  let root: string;
  if (projectId) {
    const entry = projectRegistry.getById(projectId);
    if (!entry) {
      return { error: `unknown projectId: ${projectId} (register it first; see zana_* project tools)` };
    }
    root = canonicalize(entry.path);
    if (!fs.existsSync(root)) {
      return { error: `project path no longer exists: ${entry.path}` };
    }
  } else {
    root = canonicalize(workspace);
  }

  // No explicit cwd → run at the confinement root (today's default behaviour).
  if (!cwd) {
    return { cwd: root };
  }

  // Explicit cwd → must canonicalize to inside the root.
  const candidate = canonicalize(cwd);
  if (!isInside(root, candidate)) {
    return {
      error:
        `cwd must be within ${projectId ? `project ${projectId}` : "the workspace"} ` +
        `(${root}); refusing "${cwd}" which resolves to ${candidate}`,
    };
  }
  return { cwd: candidate };
}
