import { applicationContext } from '../../../../server/application-context';
import { getSession } from '../../../../server/auth';
import { decide } from '../../../../server/rbac/decide';
import { resolveTeamViewer } from '../../../../server/team/team-viewer';

export const NOT_ALLOWED = 'Only workspace Owners and Admins can manage storage connections.';

/**
 * Whether this caller may manage storage connections: the `decide()` question the
 * `POST /api/storage-connections` route answers (Owner and Admin), asked on the server before the
 * page renders. An unwired RBAC runtime or no session fails closed.
 */
export async function callerManagesStorage(): Promise<boolean> {
  const rbac = applicationContext()?.rbac ?? null;
  if (rbac === null) return false;
  const session = await getSession();
  if (session === null) return false;
  const viewer = await resolveTeamViewer(rbac.directory, session);
  return (
    viewer !== null &&
    decide({
      role: viewer.role,
      method: 'POST',
      path: '/api/storage-connections',
      ownership: 'not-applicable',
      scope: null,
    }).effect === 'allow'
  );
}
