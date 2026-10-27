/**
 * `POST /api/invitations/:id/resend` — mint a fresh token and expiry for the same row. Issue #121.
 *
 * `resend` is declared a sub-resource of `invitations` in
 * `apps/web/server/rbac/declarations/W9-TEAM-121.ts`, so it inherits `invitations`' own grants —
 * Owner and Admin, the same as `POST /api/invitations` and `DELETE /api/invitations/:id`.
 */
import { resendInvitation } from '../../../../../server/invitations/handlers';
import { applicationContext } from '../../../../../server/application-context';
import { authorise, problem, readIdParam, toResponse } from '../../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `POST /api/invitations/:id/resend` — reissue the token. The old one no longer works. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await authorise(request, 'unknown', async ({ directory, principal }) => {
    const invitations = applicationContext()?.invitations ?? null;
    if (invitations === null) {
      return problem(
        503,
        'invitations_runtime_not_configured',
        'The invitation audit sink and send-invitation seam are not wired into this deployment. ' +
          'This deployment cannot serve /api/invitations; it is not that the request was rejected.',
      );
    }
    const id = await readIdParam(context);
    return resendInvitation(directory, principal, id, invitations);
  });
  return toResponse(result);
}
