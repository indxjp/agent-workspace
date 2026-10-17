import { RuntimesScreen } from '../../../../components/runtimes/runtimes-screen';
import { getSession } from '../../../../server/auth';
import { decide } from '../../../../server/rbac/decide';
import { currentRbacRuntime } from '../../../../server/rbac/runtime';
import { currentWebRuntimeRegistry } from '../../../../server/runtimes/registry';
import { resolveTeamViewer } from '../../../../server/team/team-viewer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Whether this caller may see the runtime registry: the same `decide()` question the
 * `/api/runtimes/:id` route answers (§21: Owner and Admin), asked on the server before anything is
 * listed, as `/admin/users` does. An unwired RBAC runtime or no session fails closed.
 */
async function callerManagesRuntimes(): Promise<boolean> {
  const rbac = currentRbacRuntime();
  if (rbac === null) return false;
  const session = await getSession();
  if (session === null) return false;
  const viewer = await resolveTeamViewer(rbac.directory, session);
  return (
    viewer !== null &&
    decide({
      role: viewer.role,
      method: 'POST',
      path: '/api/runtimes/:id',
      ownership: 'not-applicable',
      scope: null,
    }).effect === 'allow'
  );
}

export default async function RuntimesPage() {
  if (!(await callerManagesRuntimes())) {
    return (
      <p className="p-8 text-sm text-muted">Only workspace Owners and Admins can view runtimes.</p>
    );
  }
  const registry = currentWebRuntimeRegistry();
  const entries = registry === null ? [] : await registry.list();
  return <RuntimesScreen entries={entries} />;
}
