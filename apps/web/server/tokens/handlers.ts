/**
 * `POST /api/tokens` — issue #236 (SDK-04, S-1): mint a short-lived, run- or session-scoped
 * bearer a customer's own backend hands to its own frontend.
 *
 * Ordered exactly like every other route in this program (`apps/web/server/runs/api.ts`'s own
 * header states the rule): configured → authenticated → well-formed → authorised → found. The
 * body is read and validated *before* `authorise`, not after, because the ownership `decide()`
 * needs — whose row this token would be scoped to — comes from the body, not the path; every
 * other route in this program reads that fact from a path segment or omits an ownership fact
 * entirely, and this is the one that cannot.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  BROWSER_TOKEN_DEFAULT_TTL_SECONDS,
  MintTokenRequestSchema,
  type MintTokenResponse,
} from '@indx-workspace/contracts/tokens';

import {
  authorise,
  problem,
  readJsonBody,
  type ApiResult,
  type OwnershipResolver,
} from '../rbac/http';
import type { Principal } from '../rbac/principal';
import type { BrowserTokenScope } from '../rbac/token-scope';
import { currentTokensRuntime } from './runtime';

const notConfigured = (): ApiResult =>
  problem(
    503,
    'tokens_runtime_not_configured',
    'The token-minting route has no runtime installed.',
  );

/**
 * The one answer every refusal about the target row gives: a row that does not exist, one in
 * another workspace, an id this control plane could never have issued, a row that vanished between
 * the ownership check and the write, and one already terminal. Written once so the three call
 * sites cannot drift into telling those cases apart.
 */
const targetNotFound = (scope: BrowserTokenScope): ApiResult =>
  problem(
    404,
    scope.kind === 'run' ? 'run_not_found' : 'session_not_found',
    `no ${scope.kind} ${scope.id} in this workspace.`,
  );

/**
 * Resolve the ownership `decide()` needs for the `tokens` cell of §21's table: whose row `scope`
 * names. Refuses with an indistinguishable `404` for a target that does not exist in the caller's
 * workspace — issue #117's own shape, applied here because a token minted for a foreign target
 * must answer exactly as one minted for a target that never existed. An id that is not a UUID is
 * refused the same way, behind the wire schema that now rejects that shape before `authorise` runs.
 */
function ownershipOfScope(scope: BrowserTokenScope): OwnershipResolver {
  return async (principal: Principal) => {
    const runtime = currentTokensRuntime();
    if (runtime === null) return { kind: 'refuse', result: notConfigured() };
    // `runs.id` and `sessions.id` are `uuid` columns, so an id that is not one must never be
    // handed to a store "to see what happens" (`packages/contracts/src/identifiers.ts`): PostgreSQL
    // answers `22P02` and the caller gets a `500` instead of this resolver's indistinguishable
    // `404`. `TokenScopeSchema` now refuses a non-UUID id at the wire boundary as well, but that
    // check belongs to the contract and could be relaxed there; this is the server-side guard, and
    // it is the one that decides the status for anything that reaches the resolver.
    if (!isUuid(scope.id)) return { kind: 'refuse', result: targetNotFound(scope) };
    const found = await runtime.findTarget(principal, scope);
    if (found.kind === 'not-found') {
      return { kind: 'refuse', result: targetNotFound(scope) };
    }
    return {
      kind: 'ownership',
      ownership: found.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other',
    };
  };
}

export async function mintToken(request: Request): Promise<ApiResult> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return raw.result;
  const parsed = MintTokenRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_field',
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
        .join('; '),
    );
  }
  const { scope, ttlSeconds } = parsed.data;

  return authorise(request, ownershipOfScope(scope), async ({ principal }) => {
    const runtime = currentTokensRuntime();
    if (runtime === null) return notConfigured();
    const minted = await runtime.issue(
      principal,
      scope,
      ttlSeconds ?? BROWSER_TOKEN_DEFAULT_TTL_SECONDS,
    );
    if (minted === null) return targetNotFound(scope);
    const body: MintTokenResponse = {
      token: minted.token,
      scope,
      expiresAt: minted.expiresAt.toISOString(),
      warning:
        'This is the only time this token is shown. Only its hash is stored; it cannot be ' +
        'recovered, only revoked by revoking the run or session it is scoped to.',
    };
    return { status: 201, body };
  });
}
