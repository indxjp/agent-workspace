/**
 * `GET /api/memberships` and `POST /api/memberships`.
 *
 * Spec §34 does not print these, and under ADR-0026 that is legal only with a `mandate` naming the
 * section that requires the capability — §21, which makes a user's membership of a workspace, with
 * one of four roles, the whole of its authorisation model. The mandate lives in
 * `tests/route-declarations/W2-CP-06.ts`, where the gate can check that the section exists.
 *
 * Issue #121 keeps `POST` for controlled internal provisioning of an already-known user. The
 * human onboarding path is `/api/invitations`, which proves control of the intended OIDC identity
 * before creating a membership.
 */
import { refusingLocalRuntimeKey } from '../../../server/cli-auth/local-runtime-key-guard';
import { createMembership, listMemberships } from '../../../server/rbac/handlers';
import { readJsonBody } from '../../../server/http/result';
import { authorise, toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/memberships` — who belongs here, and with which role. */
export async function GET(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ directory }) =>
    listMemberships(directory),
  );
  return toResponse(result);
}

/** `POST /api/memberships` — attach an existing user to this workspace. */
export async function POST(request: Request): Promise<Response> {
  // S1-21: the local runtime's key attaches no member (`local-runtime-key-guard.ts`).
  const ownership = refusingLocalRuntimeKey('not-applicable');
  const result = await authorise(request, ownership, async ({ directory, principal }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    return createMembership(directory, principal.role, body.value);
  });
  return toResponse(result);
}
