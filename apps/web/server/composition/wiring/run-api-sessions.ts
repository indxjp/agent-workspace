import { log } from '../../telemetry/logger';
import { engineOfVersion } from '../../agent-versions/session-version';
import { engineForStoredPolicy } from '../../engines/session-engine';
import { createProjectRunGate } from '../../projects/archive-gate';
import { ownerPrincipalIdOf } from '../../rbac/core/owner-principal';
import type { AgentRef, RunApiEnvironment, RunPrincipal, SessionRef } from '../../runs/environment';
import type { RunApiWiring } from './run-api';
export function wireRunSessions(
  wired: Pick<
    RunApiWiring,
    | 'root'
    | 'scopes'
    | 'agents'
    | 'sessionRows'
    | 'runGate'
    | 'pinnedVersionFor'
    | 'launchRef'
    | 'sessionPin'
  >,
): Pick<
  RunApiEnvironment,
  'findAgentVersion' | 'findAgent' | 'openSession' | 'discardSession' | 'ownsRun'
> {
  const { root, scopes, sessionRows } = wired;
  return {
    findAgentVersion: async (principal, agentId, number) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      return scope === null ? null : root.agentVersions.forScope(scope).find(agentId, number);
    },

    findAgent: (principal: RunPrincipal, agentId: string, sessionId: string | null = null) =>
      findRunAgent(wired, { principal, agentId, sessionId }),

    openSession: (
      principal: RunPrincipal,
      agent: AgentRef,
      requested: string | null,
      agentVersionId?: string,
    ) => openRunSession(wired, { principal, agent, requested, agentVersionId }),

    discardSession: async (principal: RunPrincipal, sessionId: string) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope !== null) await sessionRows.forScope(scope).discardIfUnused(sessionId);
    },

    ownsRun: async (principal: RunPrincipal, run) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return false;
      const session = await sessionRows.forScope(scope).get(run.sessionId);
      return session?.ownerPrincipalId === ownerPrincipalIdOf(principal);
    },
  };
}
async function findRunAgent(
  wired: RunSessionWiring,
  {
    principal,
    agentId,
    sessionId,
  }: { principal: RunPrincipal; agentId: string; sessionId: string | null },
): Promise<AgentRef | null> {
  const { root, scopes, agents, runGate, sessionPin } = wired;
  // Check workspace usability before lookup so archived workspaces disclose no agent.
  if (!(await runGate.isUsable(principal.workspaceId))) return null;
  const agent = await agents.forWorkspace(principal.workspaceId).get(agentId);
  // The store is already scoped to the workspace, so an agent it returns is this principal's
  // by construction. The id is echoed from the record rather than from the path.
  if (agent === null) return null;
  // Issue #612: a follow-up in a pinned conversation runs its version's engine, not the row's
  // a push moved.
  const pin = await sessionPin(principal.workspaceId, agent.id, sessionId);
  const scope = pin === null ? null : await scopes.forWorkspaceId(principal.workspaceId);
  const version =
    scope === null || pin === null ? null : await root.agentVersions.forScope(scope).findById(pin);
  return {
    id: agent.id,
    workspaceId: principal.workspaceId,
    // ADR-0065: the agent's own engine, which `startRun` compares against the session's
    // pin. A NULL policy column reads as the compiled policy's arm, not as "unknown".
    engine: version === null ? engineForStoredPolicy(agent.policy) : engineOfVersion(version),
    ...(agent.archivedAt === undefined ? {} : { archived: true as const }),
  };
}

async function openRunSession(
  wired: RunSessionWiring,
  {
    principal,
    agent,
    requested,
    agentVersionId,
  }: {
    principal: RunPrincipal;
    agent: AgentRef;
    requested: string | null;
    agentVersionId: string | undefined;
  },
): Promise<SessionRef | null> {
  const { root, scopes, sessionRows, runGate, pinnedVersionFor, launchRef } = wired;
  // Defence in depth for a caller that reaches `openSession` some other way than the one
  // `findAgent`-then-`openSession` path this composition root wires today (issue #119).
  if (!(await runGate.isUsable(principal.workspaceId))) return null;
  const scope = await scopes.forWorkspaceId(principal.workspaceId);
  if (scope === null) return null;
  const sessions = sessionRows.forScope(scope);
  if (requested !== null) {
    const existing = await sessions.get(requested);
    if (
      existing === null ||
      existing.agentId !== agent.id ||
      existing.ownerPrincipalId !== ownerPrincipalIdOf(principal) ||
      existing.status !== 'active'
    ) {
      return null;
    }
    // A resumed session still starts a new run, so archived projects must refuse it.
    if (
      !(await createProjectRunGate(root.projects.forScope(scope)).isUsableForNewWork(
        existing.projectId,
      ))
    ) {
      return null;
    }
    return launchRef(scope, existing);
  }
  // Persist the session before a run can reference its tenant-paired foreign key.
  const outcome = await sessions.ensure({
    id: crypto.randomUUID(),
    agentId: agent.id,
    ownerPrincipalId: ownerPrincipalIdOf(principal),
    userId: principal.userId,
    agentVersionId: agentVersionId ?? (await pinnedVersionFor(scope, agent.id)),
  });
  if (outcome.kind === 'created' || outcome.kind === 'existing') {
    return launchRef(scope, outcome.session);
  }
  // The route maps both concurrent deletion and membership loss to 409; retain the cause.
  log.error(
    `[compose] no session could be opened for agent ${agent.id}: ${outcome.kind}. The run route will answer 409.`,
  );
  return null;
}

type RunSessionWiring = Parameters<typeof wireRunSessions>[0];
