/**
 * `PATCH /api/memberships/:id` and `DELETE /api/memberships/:id` — change a member's role, and
 * remove a member.
 *
 * Both carry a `mandate` on §21 in `tests/route-declarations/W2-CP-06.ts`: §34 prints neither, and
 * §21's four roles are not a model anyone can operate without a way to move a member between them.
 *
 * ## Why the ownership answer is `unknown`
 *
 * `authorise` is called before the row is read, so this handler does not yet know whose membership
 * it is. `unknown` is the honest answer and it **denies** for every grant narrower than `any` —
 * which is the safe direction, and which costs nothing here because §21 gives these two routes to
 * Owner and Admin, whose grant over `memberships` is `any`. Reading the row first to establish
 * ownership would answer a question about a row's existence to a caller who is not allowed to ask.
 */
import { refusingLocalRuntimeKey } from '../../../../server/cli-auth/local-runtime-key-guard';
import { changeMembershipRole, deleteMembership } from '../../../../server/rbac/handlers';
import { authorise, readIdParam, readJsonBody, toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `PATCH /api/memberships/:id` — change one member's role to one of §21's four. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // S1-21: the local runtime's key changes no member's role (`local-runtime-key-guard.ts`).
  const ownership = refusingLocalRuntimeKey('unknown');
  const result = await authorise(request, ownership, async ({ directory, principal }) => {
    const id = await readIdParam(context);
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    // Including this caller's own membership row. That was the second half of the escalation the
    // verifier ran: an Admin PATCHing itself to `owner`. The row being the caller's own is not a
    // reason the conferral question does not apply — it is the reason it does.
    return changeMembershipRole(directory, principal.role, id, body.value);
  });
  return toResponse(result);
}

/** `DELETE /api/memberships/:id` — remove a member from this workspace. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // S1-21: the local runtime's key removes no member (`local-runtime-key-guard.ts`).
  const ownership = refusingLocalRuntimeKey('unknown');
  const result = await authorise(request, ownership, async ({ directory, principal }) =>
    deleteMembership(directory, principal.role, await readIdParam(context)),
  );
  return toResponse(result);
}
