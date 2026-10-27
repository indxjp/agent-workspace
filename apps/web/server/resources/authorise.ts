import { applicationContext } from '../application-context';
import { noStoreResultResponse, type ApiResult } from '../http/result';
import { authorise, problem, type OwnershipResolver } from '../rbac/http';
import { decide, type Ownership } from '../rbac/decide';
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
  if (result.status !== 204) return { ok: false, response: noStoreResultResponse(result) };
  if (principal === null) {
    throw new Error('RBAC allowed a resource request without retaining its verified principal.');
  }
  return { ok: true, principal };
}

/**
 * Decide again for a principal {@link requireResourceAccess} already verified, once the handler
 * holds the lock on the path it writes: the ownership read before the lock can be stale by then,
 * e.g. another member created the file meanwhile (FX-1). `null` allows; otherwise the problem the
 * first decision would have answered.
 */
export async function recheckResourceAccess(
  request: Request,
  principal: Principal,
  ownership: OwnershipResolver,
): Promise<ApiResult | null> {
  const application = applicationContext();
  if (application === null) {
    return problem(503, 'rbac_runtime_not_configured', 'The RBAC runtime is no longer wired.');
  }
  const outcome = await ownership(
    principal,
    application.rbac.directory.forWorkspace(principal.workspaceId),
  );
  if (outcome.kind === 'refuse') return outcome.result;
  const decision = decide({
    role: principal.role,
    method: request.method,
    path: new URL(request.url).pathname,
    ownership: outcome.ownership,
    scope: principal.scope,
  });
  if (decision.effect === 'allow') return null;
  return decision.effect === 'deny'
    ? problem(403, decision.code ?? 'forbidden', decision.because)
    : problem(500, 'authorisation_undecidable', decision.because);
}
