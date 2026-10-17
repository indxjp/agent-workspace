/**
 * The seam between `POST /api/tokens` (issue #236, SDK-04, S-1) and the run/session rows and the
 * `browser_tokens` repository — the same shape `apps/web/server/models/runtime.ts` and
 * `apps/web/server/runs/environment.ts` use, for the same reason: this route needs the database
 * layer, and `apps/web/server/rbac/**` is deliberately narrow (a `WorkspaceDirectory` of users,
 * memberships, and API keys, no runs or sessions).
 */
import type { Principal } from '../rbac/principal';
import type { BrowserTokenScope } from '../rbac/token-scope';

/** Whether the scope's target row exists in the caller's workspace, and who owns it. */
export type TokenTargetLookup =
  { readonly kind: 'found'; readonly ownerPrincipalId: string } | { readonly kind: 'not-found' };

export interface MintedBrowserTokenResult {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokensRuntime {
  /**
   * Resolve the scope's target row within `principal`'s workspace. `not-found` covers a row that
   * does not exist and a row in another workspace alike — §25's isolation is not satisfied by a
   * status code that confirms the row exists elsewhere.
   */
  findTarget(principal: Principal, scope: BrowserTokenScope): Promise<TokenTargetLookup>;
  /**
   * Mint and persist a token scoped to `scope`, attributed to `principal` as its minter. `null`
   * only for the race where the target row vanished between the ownership check and this call;
   * the route answers the same `404` either way.
   */
  issue(
    principal: Principal,
    scope: BrowserTokenScope,
    ttlSeconds: number,
  ): Promise<MintedBrowserTokenResult | null>;
}

interface Registry {
  __agentWorkspaceTokensRuntime__?: TokensRuntime;
}
const registry = globalThis as typeof globalThis & Registry;

export function configureTokensRuntime(runtime: TokensRuntime): void {
  registry.__agentWorkspaceTokensRuntime__ = runtime;
}

export function clearTokensRuntime(): void {
  delete registry.__agentWorkspaceTokensRuntime__;
}

export function currentTokensRuntime(): TokensRuntime | null {
  return registry.__agentWorkspaceTokensRuntime__ ?? null;
}
