/**
 * `DELETE /api/invitations/:id` — revoke. Issue #121.
 *
 * `authorise`'s ownership answer is `unknown`: the handler has not read the row yet, and `unknown`
 * denies for every grant narrower than `any` — the same reasoning
 * `apps/web/app/api/memberships/[id]/route.ts`'s header gives, and it costs nothing here because
 * `invitations`' grant is `any` for the only role that reaches this route (§21 Owner, and Admin's
 * `MANAGE`, `apps/web/server/rbac/permissions.ts`).
 */
import { revokeInvitation } from '../../../../server/invitations/handlers';
import { applicationContext } from '../../../../server/application-context';
import { authorise, problem, readIdParam, toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `DELETE /api/invitations/:id` — revoke an invitation. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await authorise(request, 'unknown', async ({ directory, principal }) => {
    const invitations = applicationContext()?.invitations ?? null;
    if (invitations === null) {
      return problem(
        503,
        'invitations_runtime_not_configured',
        'The invitation audit sink is not wired into this deployment. This deployment cannot ' +
          'serve /api/invitations; it is not that the request was rejected.',
      );
    }
    const id = await readIdParam(context);
    return revokeInvitation(directory, principal, id, invitations);
  });
  return toResponse(result);
}
