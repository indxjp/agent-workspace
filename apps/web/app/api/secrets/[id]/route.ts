/**
 * `PUT` and `DELETE /api/secrets/:id` — spec §23, §26. Replace (rotate) a secret's value, or delete
 * an unreferenced secret. There is no `GET`: §23's write-only rule means no route on this resource
 * returns a value. Both `mandate`s are in `tests/route-declarations/W2-CP-02.ts` (ADR-0026) — the
 * delete too, because `no-plaintext-leak.test.ts` refuses a secrets route declared anywhere else;
 * §34 prints no secrets route at all.
 *
 * Imports are relative, not `@/…`, for the reason given in `../route.ts`.
 */
import { deleteSecret, replaceSecret } from '../../../../server/secrets/handlers';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import {
  readJsonBody,
  readSecretIdParam,
  toResponse,
  withWorkspaceStore,
} from '../../../../server/secrets/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Next 15+ resolves a dynamic segment asynchronously, so `params` is a promise. */
type SecretRouteContext = { params: Promise<{ id: string }> };

/**
 * `PUT /api/secrets/:id` — replace a secret's value by id. Gated by the shared decision table
 * first, exactly as `DELETE` below is (issue #388): secrets are Owner-only, so every other role is
 * `403` whether or not the id exists, and the body is parsed only after the gate.
 */
export async function PUT(request: Request, context: SecretRouteContext): Promise<Response> {
  const id = await readSecretIdParam(context);
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (store) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return replaceSecret(store, id, body.value);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * `DELETE /api/secrets/:id` — delete a secret nothing references (ADR-0077). Gated by the shared
 * decision table before the id is looked at: secrets are Owner-only, so every other role is `403`
 * whether or not the id exists, and an Owner asking for another workspace's id gets the same
 * `404 secret_not_found` as for an id that never existed.
 */
export async function DELETE(request: Request, context: SecretRouteContext): Promise<Response> {
  const id = await readSecretIdParam(context);
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    (store) => deleteSecret(store, id),
    access.principal.workspaceId,
  );
  return toResponse(result);
}
