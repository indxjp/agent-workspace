/**
 * `GET /api/users` and `POST /api/users` — the two user routes spec §34 prints, and no third.
 *
 * These functions are deliberately trivial: everything worth testing is in
 * `apps/web/server/rbac/`, which a test imports without the framework. The imports are relative
 * rather than `@/…` because the `@/` alias is a bundler setting that Vitest does not resolve for
 * this workspace member, and a route file no test can import is a route whose wiring is an
 * untested claim (`apps/web/app/api/agents/route.ts` records the same reasoning).
 *
 * `authorise` is the first thing each of them does and the body is read inside it, so the
 * authorisation gate runs before the parser. The order is load-bearing: reading the body first
 * would answer `400 malformed_body` to a caller who has no business getting an answer about this
 * route's body format.
 *
 * Issue #121 keeps `POST` as controlled internal provisioning. It creates the global user and
 * membership immediately and therefore is not the default human invitation path; callers that
 * need proof of recipient identity use `/api/invitations` instead.
 */
import { refusingLocalRuntimeKey } from '../../../server/cli-auth/local-runtime-key-guard';
import { createUser, listUsers } from '../../../server/rbac/handlers';
import { readJsonBody } from '../../../server/http/result';
import { authorise, toResponse } from '../../../server/rbac/http';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and none is prerendered. Correct here independently of the gate — these handlers
// read the session cookie through `authorise`.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/users` — the members of the caller's workspace, and no other workspace's (§25). */
export async function GET(request: Request): Promise<Response> {
  // A collection route names no single row, so there is no owner to establish.
  const result = await authorise(request, 'not-applicable', ({ directory }) =>
    listUsers(directory),
  );
  return toResponse(result);
}

/** `POST /api/users` — add a member to the caller's workspace with one of §21's four roles. */
export async function POST(request: Request): Promise<Response> {
  // S1-21: the local runtime's key adds no member (`local-runtime-key-guard.ts`).
  const ownership = refusingLocalRuntimeKey('not-applicable');
  const result = await authorise(request, ownership, async ({ directory, principal }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    // The caller's own role, read from the membership row by `identify`, is what the requested
    // role is measured against. A route cannot reach the directory with a role it took from the
    // body and did not confer: `CreateUserInput.role` is a `ConferredRole` (see conferral.ts).
    return createUser(directory, principal.role, body.value);
  });
  return toResponse(result);
}
