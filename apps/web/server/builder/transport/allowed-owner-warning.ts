import type { AgentRecord } from '../../agents/contract';
import type { DirectoryRoot } from '../../rbac/directory';

/** The agent a run belongs to, as far as the warning needs it. */
export type AllowedAgent = Pick<AgentRecord, 'id' | 'ownerPrincipalId'>;

export interface AllowedOwnerWarningDeps {
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  readonly warn: (message: string, fields: Readonly<Record<string, string>>) => void;
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** How long an owner found to be an Owner or Admin is trusted before the next run looks again. */
export const OWNER_OK_TTL_MS = 10 * 60 * 1000;

/**
 * A warning, once per agent, for an allow-listed agent whose owner is not an Owner or Admin of its
 * workspace (#1851). An owner who checked out is looked at again every 10 minutes. The deployment
 * allow-list matches by name and only an Owner or Admin may give such a name, so a Builder- or Viewer-owned
 * agent under one means the name was given before the list named it, or the owner's role has since
 * been lowered: the operator should know.
 *
 * There is no cross-workspace agent query to run at startup, so this runs when such an agent's run
 * reaches the door. An agent is remembered only once it has warned. An owner found to be fine is
 * trusted for {@link OWNER_OK_TTL_MS}, so a role lowered later is still caught on a run after that,
 * without a membership lookup on every run. It never refuses and never throws: a directory failure
 * only means the agent is looked at again on its next run.
 */
export function createAllowedOwnerWarning(
  deps: AllowedOwnerWarningDeps,
): (workspaceId: string, agent: AllowedAgent) => Promise<void> {
  const now = deps.now ?? Date.now;
  const warned = new Set<string>();
  const fineUntil = new Map<string, number>();
  return async (workspaceId, agent) => {
    if (warned.has(agent.id)) return;
    if ((fineUntil.get(agent.id) ?? 0) > now()) return;
    try {
      const owner = await deps.directory
        .forWorkspace(workspaceId)
        .findMembershipByPrincipal(agent.ownerPrincipalId);
      if (owner !== null && (owner.role === 'owner' || owner.role === 'admin')) {
        fineUntil.set(agent.id, now() + OWNER_OK_TTL_MS);
        return;
      }
      warned.add(agent.id);
      deps.warn(
        '[builder] an allow-listed agent is owned by someone who is not an Owner or Admin of its workspace',
        {
          workspaceId,
          agentId: agent.id,
          ownerPrincipalId: agent.ownerPrincipalId,
          ownerRole: owner === null ? 'none' : owner.role,
        },
      );
    } catch {
      // A directory failure is not an answer: the agent is looked at again on its next run.
    }
  };
}
