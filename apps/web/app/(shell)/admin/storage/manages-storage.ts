import { applicationContext } from '../../../../server/application-context';
import { getSession } from '../../../../server/auth';
import { decide } from '../../../../server/rbac/decide';
import { parseRole } from '../../../../server/rbac/roles';
import { resolveTeamViewer } from '../../../../server/team/team-viewer';

export const NOT_ALLOWED = 'Only workspace Owners and Admins can manage storage connections.';

/**
 * Whether a directory role may manage storage connections: the `decide()` question the
 * `POST /api/storage-connections` route answers (Owner and Admin). The page gate below and the
 * sidebar's Storage entry both ask it, so the entry is shown exactly to the callers the page
 * admits. A value that is not a role is refused.
 */
export function roleManagesStorage(role: unknown): boolean {
  const parsed = parseRole(role);
  return (
    parsed !== null &&
    decide({
      role: parsed,
      method: 'POST',
      path: '/api/storage-connections',
      ownership: 'not-applicable',
      scope: null,
    }).effect === 'allow'
  );
}

/**
 * Whether this caller may manage storage connections ({@link roleManagesStorage}), asked on the
 * server before the page renders. An unwired RBAC runtime or no session fails closed.
 */
export async function callerManagesStorage(): Promise<boolean> {
  const rbac = applicationContext()?.rbac ?? null;
  if (rbac === null) return false;
  const session = await getSession();
  if (session === null) return false;
  const viewer = await resolveTeamViewer(rbac.directory, session);
  return viewer !== null && roleManagesStorage(viewer.role);
}
