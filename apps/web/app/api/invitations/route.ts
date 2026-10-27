/**
 * `GET /api/invitations` and `POST /api/invitations` — issue #121.
 *
 * Thin wiring over `apps/web/server/invitations/handlers.ts`, the same split
 * `apps/web/app/api/users/route.ts`'s header explains: everything worth testing lives in the
 * framework-free handler, and this file exists so `tests/route-inventory.test.ts` sees a route
 * that answers, and so `routes.test.ts`-style suites can drive the real wiring with a real
 * `Request`.
 *
 * Neither method is printed in spec §34 — the invitation lifecycle postdates the specification —
 * so both carry a `mandate` in `tests/route-declarations/W9-TEAM-121.ts` citing §21, the same
 * section `/api/memberships` cites for the same reason (ADR-0026).
 */
import { createInvitation, listInvitations } from '../../../server/invitations/handlers';
import { applicationContext } from '../../../server/application-context';
import { readJsonBody } from '../../../server/http/result';
import { authorise, problem, toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `503`, named, when the audit sink and `sendInvitation` seam are not wired — never a silent skip. */
function invitationsRuntimeUnconfigured() {
  return problem(
    503,
    'invitations_runtime_not_configured',
    'The invitation audit sink and send-invitation seam are not wired into this deployment. ' +
      'This deployment cannot serve /api/invitations; it is not that the request was rejected.',
  );
}

/** `GET /api/invitations` — every invitation this workspace has ever sent. */
export async function GET(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ directory, principal }) =>
    listInvitations(directory, principal),
  );
  return toResponse(result);
}

/** `POST /api/invitations` — invite an address to one of §21's four roles this caller may confer. */
export async function POST(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', async ({ directory, principal }) => {
    const invitations = applicationContext()?.invitations ?? null;
    if (invitations === null) return invitationsRuntimeUnconfigured();
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    return createInvitation(directory, principal, body.value, invitations);
  });
  return toResponse(result);
}
