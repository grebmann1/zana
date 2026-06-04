// Team-runtime + checkpoint-resume glue. Thin handlers extracted from the
// dispatch switch in agents/manager.ts; called from agents/dispatch.ts.
//
// All cross-package access uses lazyRequire to keep the core ↔ work cycle
// from biting at module-load time (see CLAUDE.md cycle paragraph).

import { lazyRequire } from "../util/lazy-require";
import * as profileStore from "./profile-store";
import { spawnHeadlessAgent, getAgent, checkSystemResources } from "./lifecycle";

const work = lazyRequire<typeof import("@zana-ai/work")>("@zana-ai/work");
function _checkpointStore() { return work.runs.checkpoint.store; }
function _checkpointResume() { return work.runs.checkpoint.resume; }

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function listTeams() {
  return work.teams.store.listTeams();
}

export function getTeam(teamId: string) {
  const team = work.teams.store.getTeam(teamId);
  if (!team) return { error: `team not found: ${teamId}` };
  return team;
}

export function startTeam(
  params: { teamId: string; cwd?: string; prompt?: string },
  getWorkspaceFn?: (() => string) | null,
) {
  const teamMod = work.teams.manager;
  const cwd = params.cwd || (getWorkspaceFn ? getWorkspaceFn() : process.env.HOME);
  const hardError = checkSystemResources("hard");
  if (hardError) {
    return { ok: false, error: `cannot start team: ${hardError}` };
  }
  return teamMod.startTeam(params.teamId, { prompt: params.prompt, cwd, headless: true });
}

export function stopTeam(teamId: string) {
  return work.teams.manager.stopTeam(teamId);
}

export function teamStatus(teamId: string) {
  const status = work.teams.manager.getTeamStatus(teamId);
  if (!status) return { error: `team not running: ${teamId}` };
  return status;
}

export function listRunningTeams() {
  return work.teams.manager.listRunningTeams();
}

export function saveTeam(team: any) {
  const saved = work.teams.store.saveTeam(team);
  return { ok: true, id: saved.id, name: saved.name };
}

export function deleteTeam(teamId: string) {
  const ok = work.teams.store.deleteTeam(teamId);
  return { ok };
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export function checkpointSave(params: any) {
  const cp = _checkpointStore().save(params);
  return { ok: true, checkpointId: cp.id };
}

export function checkpointList(params: any) {
  return _checkpointStore().list(params);
}

export function checkpointGet(checkpointId: string) {
  const cp = _checkpointStore().load(checkpointId);
  if (!cp) return { error: "checkpoint not found" };
  return cp;
}

export async function checkpointResume(checkpointId: string) {
  return await _checkpointResume().resume(
    checkpointId,
    { spawnHeadlessAgent, getAgent },
    profileStore,
  );
}
