/**
 * "May the person looking at this agent restore it?" — answered on the server by the same
 * `decide()` table `POST /api/agents/:id/restore` consults, and handed to the agent page as a prop
 * (issue #1851). It reuses the project archive capability's mechanism and its reasoning
 * (`../projects/archive-capability.ts`): no role table in the browser, no state-changing probe, and
 * an unresolvable caller is refused.
 */
import type { AgentRestoreCapability } from '../../contracts/agents';
import { applicationContext } from '../application-context';
import { getSession } from '../auth';
import { archiveCapabilityFor, archiveGrantsForRole } from '../projects/archive-capability';

const RESTORE_PATH = '/api/agents/:id/restore';

/** The answer for a caller nothing could be established about. Every field denies. */
export const NO_RESTORE_CAPABILITY: AgentRestoreCapability = {
  canRestoreOwn: false,
  canRestoreOther: false,
  viewerPrincipalId: null,
};

/** Both ownership answers for the restore route; exported so the test can drive the role matrix. */
export function agentRestoreGrantsForRole(role: string): {
  readonly canRestoreOwn: boolean;
  readonly canRestoreOther: boolean;
} {
  const grants = archiveGrantsForRole(role, RESTORE_PATH);
  return { canRestoreOwn: grants.canArchiveOwn, canRestoreOther: grants.canArchiveOther };
}

/** The signed-in caller's restore capability for the current request. */
export async function resolveAgentRestoreCapability(): Promise<AgentRestoreCapability> {
  const runtime = applicationContext()?.rbac ?? null;
  if (runtime === null) return NO_RESTORE_CAPABILITY;
  const session = await getSession();
  if (session === null) return NO_RESTORE_CAPABILITY;
  const capability = await archiveCapabilityFor(runtime.directory, session, RESTORE_PATH);
  return {
    canRestoreOwn: capability.canArchiveOwn,
    canRestoreOther: capability.canArchiveOther,
    viewerPrincipalId: capability.viewerPrincipalId,
  };
}
