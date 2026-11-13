/**
 * Who may reach a run, for every §34 run handler in `api.ts` and the routes beside it: the shared
 * refusals (not configured, unauthenticated, invalid id, not found), `decide()` against spec §21's
 * `runs` classification, a session scope's row identity and a visitor's limits.
 *
 * `api.ts` re-exports every symbol here that another module imports, so `runs/api` stays the one
 * public import path.
 */
import { SURFACE_LIMIT_PROBLEM_CODES } from '@indx-workspace/contracts/surfaces';

import {
  RUN_API_NOT_CONFIGURED_MESSAGE,
  type RunPrincipal,
  type RunApiEnvironment,
} from './environment';
import { apiError } from './http';
import type { RunRecord, RunStore } from './store';
import { decide, type Decision, type Grant, type Ownership, parseRole } from '../identity';

/** The authenticated caller of a run handler: its request, the run API and who it is. */
export interface RunHandlerCaller {
  readonly request: Request;
  readonly env: RunApiEnvironment;
  readonly principal: RunPrincipal;
}

export const notConfigured = (): Response =>
  apiError(503, 'run_api_not_configured', RUN_API_NOT_CONFIGURED_MESSAGE);

export const unauthenticated = (): Response =>
  apiError(401, 'unauthenticated', 'this endpoint requires an authenticated session.');

export const invalidRunId = (): Response =>
  apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');

export const runNotFound = (runId: string): Response =>
  apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);

/** The answer to a `decide()` that did not allow: `403` for a denial, `500` when it could not decide. */
function denialFor(decision: Exclude<Decision, { readonly effect: 'allow' }>): Response {
  return apiError(
    decision.effect === 'deny' ? 403 : 500,
    decision.effect === 'deny' ? (decision.code ?? 'forbidden') : 'authorisation_undecidable',
    decision.because,
  );
}

export function requireRunPermission(
  request: Request,
  principal: RunPrincipal,
  ownership: Ownership,
): Response | null {
  const role = parseRole(principal.role);
  if (role === null)
    return apiError(403, 'forbidden', 'the authenticated identity has no recognised role.');
  const decision = decide({
    role,
    method: request.method,
    path: new URL(request.url).pathname,
    ownership,
    scope: principal.scope ?? null,
  });
  if (decision.effect === 'allow') return null;
  return denialFor(decision);
}

/**
 * The row-identity half of a session-scoped browser token's grammar (issue #236, SDK-04, S-1).
 *
 * `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) enforces which route *shapes* a
 * session scope may reach — reading a run, starting one — and, for a run scope, that the path's
 * own `:id` names the scoped row. It cannot enforce a session scope's row identity the same way:
 * on `GET /api/runs/:id`/`:id/events` the `:id` is a *run*, and on `POST /api/agents/:id/runs` it
 * is an *agent*, so in neither shape does the path itself carry the session id to compare against.
 * That comparison happens here, where the row (or the request body) is already in hand, and it
 * denies with the same `token_out_of_scope` code `decide()` uses so a caller cannot tell the two
 * halves of the same rule apart.
 */
export function requireSessionScopeMatch(
  principal: RunPrincipal,
  sessionId: string | null,
): Response | null {
  const scope = principal.scope;
  if (scope === null || scope === undefined || scope.kind !== 'session') return null;
  if (sessionId === scope.id) return null;
  return apiError(
    403,
    'token_out_of_scope',
    `this session-scoped browser token is scoped to session ${scope.id}, and ` +
      (sessionId === null
        ? 'this request names no session at all.'
        : `this request is for session ${sessionId}.`),
  );
}

/**
 * A session-scoped token's turn or rating past its surface's limits (issue #622; #606): `429` with
 * the typed code, and `Retry-After` when waiting lifts it. `null` admits it, and is the answer for
 * every other principal.
 */
export async function refuseOverVisitorLimit(
  env: RunApiEnvironment,
  principal: RunPrincipal,
  kind: 'turn' | 'feedback',
  headers: Headers,
): Promise<Response | null> {
  const scope = principal.scope;
  if (env.admitVisitorWrite === undefined || scope?.kind !== 'session') return null;
  const refusal = await env.admitVisitorWrite(principal.workspaceId, scope.id, kind, headers);
  if (refusal === null) return null;
  const response = apiError(
    SURFACE_LIMIT_PROBLEM_CODES[refusal.code],
    refusal.code,
    refusal.message,
  );
  if (refusal.retryAfterSeconds !== null) {
    response.headers.set('retry-after', String(refusal.retryAfterSeconds));
  }
  return response;
}

/**
 * Look a run up and confirm it belongs to this principal's workspace.
 *
 * Returns `null` for "no such run" and for "not yours" alike, and both become a 404. §25's
 * isolation is not satisfied by a status code that tells a caller the row exists.
 */
export async function findRunForPrincipal(
  store: RunStore,
  principal: RunPrincipal,
  runId: string,
): Promise<RunRecord | null> {
  const run = await store.get(runId);
  if (run === null) return null;
  return run.workspaceId === principal.workspaceId ? run : null;
}

export type AuthorisedRun =
  | { readonly kind: 'found'; readonly run: RunRecord }
  | { readonly kind: 'refused'; readonly response: Response };

/**
 * Whether {@link findAuthorisedRun} compares a session scope against the run's session.
 * `POST /api/runs/:id/interrupt` has never made that comparison, and it is not added here: a
 * handler states which rule it keeps rather than gaining one silently.
 */
export type SessionScopeCheck = 'match-session' | 'not-checked';

/**
 * A run this caller may act on, in the order every single-run handler checks it: found in the
 * caller's workspace (`404` otherwise, §25) → the session scope's row, when `sessionScope` asks for
 * it → `decide()` with the caller's ownership of the run. The run id is already a UUID.
 */
export async function findAuthorisedRun(
  caller: RunHandlerCaller,
  runId: string,
  sessionScope: SessionScopeCheck,
): Promise<AuthorisedRun> {
  const { request, env, principal } = caller;
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return { kind: 'refused', response: runNotFound(runId) };
  if (sessionScope === 'match-session') {
    const scopeMismatch = requireSessionScopeMatch(principal, run.sessionId);
    if (scopeMismatch !== null) return { kind: 'refused', response: scopeMismatch };
  }
  const permission = requireRunPermission(
    request,
    principal,
    (await env.ownsRun(principal, run)) ? 'own' : 'other',
  );
  if (permission !== null) return { kind: 'refused', response: permission };
  return { kind: 'found', run };
}

type RunListAccess =
  | { readonly kind: 'allowed'; readonly grant: Grant }
  | { readonly kind: 'denied'; readonly response: Response };

/**
 * `decide()` against spec §21's `runs` classification, exactly as {@link requireRunPermission}
 * does for the single-run routes, plus the one extra fact a collection route needs and a
 * single-row route does not: the grant's *width*. `not-applicable` is this route's honest
 * ownership answer — §34 names no single row here — and `decide()`'s own contract for that pair
 * (`rbac/decide.ts`'s comment on `applyGrant`'s `own` arm) is that the width is returned so the
 * caller can filter the result set itself, which `parseRunListQuery` then does.
 */
export function decideRunListAccess(request: Request, principal: RunPrincipal): RunListAccess {
  const role = parseRole(principal.role);
  if (role === null) {
    return {
      kind: 'denied',
      response: apiError(403, 'forbidden', 'the authenticated identity has no recognised role.'),
    };
  }
  const decision = decide({
    role,
    method: request.method,
    path: new URL(request.url).pathname,
    ownership: 'not-applicable',
    scope: principal.scope ?? null,
  });
  // Unreachable today (round 2 finding 4, gap G-8): every role in `permissions.ts` has `read:
  // 'own'` or `'any'` on `runs`, so `decide()` never returns anything but `allow` here. Kept, and
  // left untested, rather than deleted — this is the same fail-closed shape every other route's
  // authorisation check uses, and `permissions.ts` (outside this task's `Owns` globs) is the only
  // file that could ever make a role take this branch.
  if (decision.effect !== 'allow') {
    return { kind: 'denied', response: denialFor(decision) };
  }
  if (decision.facts === null) {
    // `facts` is null only for `decide()`'s public surface, and `/api/runs` is never that —
    // reported rather than assumed away (ADR-0015).
    throw new Error('GET /api/runs was allowed with no route facts to read the grant from.');
  }
  return { kind: 'allowed', grant: decision.facts.grant };
}
