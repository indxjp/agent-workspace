import { authorise, toResponse, type OwnershipResolver } from '../rbac/http';
import type { Ownership } from '../rbac/decide';
import type { Principal } from '../rbac/principal';

export type ResourceAccess =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly response: Response };

/**
 * Apply the repository's single RBAC decision table and retain its verified principal.
 *
 * `ownership` may be a plain value or an {@link OwnershipResolver} — see `rbac/http.ts`'s own
 * comment on `authorise` for why a handler that must read a row to answer "own or other" needs the
 * resolver form.
 */
export async function requireResourceAccess(
  request: Request,
  ownership: Ownership | OwnershipResolver,
): Promise<ResourceAccess> {
  let principal: Principal | null = null;
  const result = await authorise(request, ownership, (context) => {
    principal = context.principal;
    return Promise.resolve({ status: 204, body: null });
  });
  if (result.status !== 204) return { ok: false, response: toResponse(result) };
  if (principal === null) {
    throw new Error('RBAC allowed a resource request without retaining its verified principal.');
  }
  return { ok: true, principal };
}
