/**
 * `DELETE /api/api-keys/:id` — revoke a key.
 *
 * `mandate` on §22, whose own field list contains `revoked_at`. Revocation writes that timestamp
 * rather than deleting the row: a deleted row cannot be audited (§36), and R-12 §1.5 records why
 * revocation is irreversible — `revoked_at IS NULL` is the gate every authentication runs, and a
 * nullable column that can be set back to `NULL` is a resurrection path.
 *
 * There is deliberately no `GET /api/api-keys/:id`. A single-key read would be the obvious place
 * for somebody to add a "reveal" affordance later, and §22 gives it nothing to return that
 * `GET /api/api-keys` does not already return for every key.
 */
import { refusingLocalRuntimeKey } from '../../../../server/cli-auth/local-runtime-key-guard';
import { revokeApiKey } from '../../../../server/rbac/handlers';
import { authorise, readIdParam, toResponse } from '../../../../server/rbac/http';
import { closeEndpointToolSandbox } from '../../../../server/tool-endpoint/close';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `DELETE /api/api-keys/:id` — revoke. Takes effect on the next request, with no propagation. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // `unknown` ownership, as on the membership route: the row has not been read, §21 gives this
  // capability to roles whose grant over `api-keys` is `any`, and an undetermined owner denies.
  // S1-21: the local runtime's key administers no key (`local-runtime-key-guard.ts`).
  const ownership = refusingLocalRuntimeKey('unknown');
  const result = await authorise(request, ownership, async ({ directory, principal }) =>
    revokeApiKey(directory, await readIdParam(context), (clientId) =>
      closeEndpointToolSandbox(principal.workspaceId, clientId),
    ),
  );
  return toResponse(result);
}
