/**
 * The HTTP edge of this task: the problem shape and `authorise` — the
 * one call every route handler of this task makes before it does anything else.
 *
 * ## `authorise` derives the route from the request, and transcribes nothing
 *
 * The method and the path handed to `decide` come from the `Request`, not from an argument the
 * handler passes about itself. A handler that named its own route could name the wrong one, and a
 * matrix test would still be green because it asks `decide` the same question the handler asks.
 * Reading `new URL(request.url).pathname` removes that whole class of disagreement: the string
 * `decide` classifies is the string the router matched.
 *
 * ## The answers, and why `refuse` is not a `403`
 *
 * ```text
 * runtime unwired     503 rbac_runtime_not_configured   nothing was checked, and nothing pretends to have been
 * identify() → null   401 unauthenticated               no session cookie and no usable API key
 * feature off         404 (features/guard.ts)           ADR-0160 D7; before the ownership read and decide()
 * decide()  → refuse  500 authorisation_undecidable     the route is not classified; see decide.ts
 * decide()  → deny    403 forbidden                     §21 says no, and the body says which sentence
 * ```
 *
 * A `403` for the third case would be a lie with a plausible shape: it asserts a rule was applied.
 * ADR-0015 and ADR-0031 both land on the same line here — a check that cannot run must fail, and
 * it must fail as itself.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';

import { featureRefusal } from '../features/guard';
import { enabledFeaturesFor } from '../features/runtime';
import { problemWithDetail as problem, type ApiResult } from '../http/result';
import { decide, type Decision, type Ownership } from './decide';
import type { WorkspaceDirectory } from './directory';
import type { Principal } from './principal';
import { applicationContext, type ApplicationContext } from '../application-context';

// ADR-0078 D7: `problem` repeats `message` as `detail` until the next major release.
export { noStoreResultResponse as toResponse, problemWithDetail as problem } from '../http/result';

/** What `authorise` hands a handler once every gate above it has answered yes. */
export interface AuthorisedRequest {
  readonly principal: Principal;
  readonly directory: import('./directory').WorkspaceDirectory;
  readonly decision: Decision;
  /** The features on for the caller's workspace (ADR-0160), for a handler that reports them. */
  readonly features: readonly FeatureId[];
  /**
   * The application context `authorise` read the RBAC runtime from: the same snapshot, so a handler
   * reads its own domain from it with no second "is anything installed" check.
   */
  readonly application: ApplicationContext;
}

/**
 * What an {@link OwnershipResolver} answers.
 *
 * `ownership` is the ordinary case: the resolver read the row (or decided none was needed) and
 * names what `decide()` should see. `refuse` is issue #117's "indistinguishable 404" case — the
 * row is absent from the caller's workspace, or in another tenant, and the resolver hands back the
 * exact {@link ApiResult} the route wants returned. `authorise` returns that result directly and
 * never calls `decide()` at all: a row that was never found was never measured against a rule, so
 * reaching decide() with a placeholder ownership would risk a `403` that asserts a check that did
 * not happen (ADR-0015 read the other way round from `refuse`'s own case in `decide.ts`).
 */
export type OwnershipOutcome =
  | { readonly kind: 'ownership'; readonly ownership: Ownership }
  | { readonly kind: 'refuse'; readonly result: ApiResult };

/**
 * Resolve the real ownership of the row a request names, once the caller's identity and a
 * workspace-scoped directory are both known.
 *
 * This exists because `decide()` needs `ownership` before a handler's own body runs — `authorise`
 * calls `decide()` and only then invokes `run` — so a handler that must READ THE ROW to answer
 * "own or other" cannot compute that value before calling `authorise`. A resolver defers the read
 * to the one point inside `authorise` where the caller's identity is already verified and no
 * verdict has been reached yet.
 */
export type OwnershipResolver = (
  principal: Principal,
  directory: WorkspaceDirectory,
) => Promise<OwnershipOutcome> | OwnershipOutcome;

/**
 * The call site. Every route handler of this task begins with it and none of them re-implements
 * any part of it.
 *
 * `ownership` is the handler's honest answer about whose row is being acted on: `not-applicable`
 * for a collection route, `own`/`other` where the handler has read the row, and `unknown` where it
 * has not. `unknown` denies for every grant narrower than `any`, which is the safe direction: a
 * route that has not established ownership cannot be given a permission that depends on it. It may
 * also be an {@link OwnershipResolver} — see that type's own comment — for a handler whose answer
 * depends on a row only the verified caller's workspace can read.
 */
export async function authorise(
  request: Request,
  ownership: Ownership | OwnershipResolver,
  run: (context: AuthorisedRequest) => Promise<ApiResult>,
): Promise<ApiResult> {
  const application = applicationContext();
  if (application === null) {
    return problem(
      503,
      'rbac_runtime_not_configured',
      'The users, memberships and API-key routes have no directory or identity resolver wired ' +
        'into them. This deployment cannot serve them; it is not that the request was rejected.',
    );
  }

  const runtime = application.rbac;
  const principal = await runtime.identify(request);
  if (principal === null) {
    return problem(
      401,
      'unauthenticated',
      'This route requires a verified session cookie or an API key presented as ' +
        '"Authorization: Bearer ak_live_…".',
    );
  }

  const directory = runtime.directory.forWorkspace(principal.workspaceId);

  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // An unreadable URL is not a route this table can classify, and classifying it as anything
    // would be inventing the resource. Refused, by the same rule as an unclassified resource.
    return problem(
      500,
      'authorisation_undecidable',
      `The request URL ${JSON.stringify(request.url)} could not be read as a URL, so no route ` +
        `could be derived from it and no authorisation decision was made.`,
    );
  }

  // ADR-0160 D7: the caller is a verified member, so the workspace is known. A switched-off
  // feature's route does not exist for it, whatever its role and whatever row the path names, so
  // this runs before the ownership resolver reads one.
  const features = await enabledFeaturesFor(principal.workspaceId);
  const refused = featureRefusal(request.method, pathname, features);
  if (refused !== null) return refused;

  let resolvedOwnership: Ownership;
  if (typeof ownership === 'function') {
    const outcome = await ownership(principal, directory);
    if (outcome.kind === 'refuse') return outcome.result;
    resolvedOwnership = outcome.ownership;
  } else {
    resolvedOwnership = ownership;
  }

  const decision = decide({
    role: principal.role,
    method: request.method,
    path: pathname,
    ownership: resolvedOwnership,
    scope: principal.scope,
  });

  switch (decision.effect) {
    case 'allow':
      return run({ principal, directory, decision, features, application });
    case 'deny':
      return problem(403, decision.code ?? 'forbidden', decision.because);
    case 'refuse':
      return problem(
        500,
        'authorisation_undecidable',
        `${decision.because} No authorisation decision was made, so this request was neither ` +
          `allowed nor refused on its merits.`,
      );
    default: {
      const unreachable: never = decision;
      throw new Error(
        `unclassified decision ${JSON.stringify(unreachable)} — refusing to serve the request`,
      );
    }
  }
}

/** Read the `[id]` segment of a dynamic route without assuming it resolved to a string. */
export async function readIdParam(context: { params: Promise<{ id: string }> }): Promise<unknown> {
  const params: unknown = await context.params;
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as Record<string, unknown>)['id'];
}
