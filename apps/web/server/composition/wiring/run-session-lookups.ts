import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { meetRunCeiling } from '../../compose/run-request';
import type { RunStartEnvironment } from '../../runs/environment';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';

export type SessionLookup = Pick<AgentsWiring, 'scopes' | 'sessionRows'>;
export type VersionLookup = Pick<AgentsWiring, 'scopes'> &
  Pick<RunResourcesWiring, 'pinnedVersionFor'>;

/** The project session `sessionId` is filed under, or `null`. */
export async function projectOfSession(
  { scopes, sessionRows }: SessionLookup,
  workspaceId: string,
  sessionId: string,
): Promise<string | null> {
  const scope = await scopes.forWorkspaceId(workspaceId);
  const sessionRow = scope === null ? null : await sessionRows.forScope(scope).get(sessionId);
  return sessionRow?.projectId ?? null;
}

/** The pin of session `sessionId`, when it is one of `agentId`'s; else `null`. */
export async function sessionPinOf(
  { scopes, sessionRows }: SessionLookup,
  workspaceId: string,
  agentId: string,
  sessionId: string | null,
): Promise<string | null> {
  if (sessionId === null) return null;
  const scope = await scopes.forWorkspaceId(workspaceId);
  const row = scope === null ? null : await sessionRows.forScope(scope).get(sessionId);
  return row?.agentId === agentId ? row.agentVersionId : null;
}

/** The version a run composes from: the one given, else the one `local` points at for a new session. */
export async function versionOfRun(
  { scopes, pinnedVersionFor }: VersionLookup,
  run: Readonly<{
    workspaceId: string;
    agentId: string;
    versionId: string | null;
    sessionId: string | null;
  }>,
): Promise<string | null> {
  if (run.versionId !== null || run.sessionId !== null) return run.versionId;
  const scope = await scopes.forWorkspaceId(run.workspaceId);
  return scope === null ? null : await pinnedVersionFor(scope, run.agentId);
}

type SpendLimitDependencies = SessionLookup &
  VersionLookup &
  Pick<RunResourcesWiring, 'readRunAgent'> & { readonly policyCeiling: ProjectPolicy | null };

/**
 * ADR-0162 decision 2: the limit the run composes with, read from the version it will run (the
 * session's pin, the version a new session is asked to pin, or `local`'s) and met with the
 * deployment ceiling by the same rule compose applies.
 */
export function spendLimitOf(
  dependencies: SpendLimitDependencies,
): NonNullable<RunStartEnvironment['spendLimitFor']> {
  return async (principal, agent, sessionId, agentVersionId) => {
    const { workspaceId } = principal;
    const pinned =
      agentVersionId ?? (await sessionPinOf(dependencies, workspaceId, agent.id, sessionId));
    const versionId = await versionOfRun(dependencies, {
      workspaceId,
      agentId: agent.id,
      versionId: pinned,
      sessionId,
    });
    const { agent: record } = await dependencies.readRunAgent(workspaceId, agent.id, versionId);
    return meetRunCeiling(
      { agent: record, permissions: record.permissions, model: null },
      dependencies.policyCeiling,
    ).met.limits.maxBudgetUsd;
  };
}
