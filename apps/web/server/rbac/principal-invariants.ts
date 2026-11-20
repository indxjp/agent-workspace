/**
 * The runtime consistency rules a `Principal` must satisfy, kept apart from the class so
 * `Principal.isPrincipal` reads as the nominal check plus one call. Each rule is defence in depth:
 * with the instance frozen and its `#provenance` unnameable, nothing outside `principal.ts` can
 * produce a value that breaks one.
 */
import type { OAuthGrant, PrincipalKind, Via } from './principal';
import { isEndpointScope, type TokenScope } from './core/token-scope';

/** The fields of a principal the invariants read; `Principal` satisfies it structurally. */
export interface PrincipalShape {
  readonly principalId: string;
  readonly ownerPrincipalId: string;
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  readonly via: Via;
  readonly apiKeyId: string | null;
  readonly scope: TokenScope | null;
  readonly oauth: OAuthGrant | null;
}

/** ADR-0161 D8: an app-backend scope carries its bound agents, and no other scope carries any. */
function carriesBoundAgentsCorrectly(scope: TokenScope | null): boolean {
  if (scope === null) return true;
  const bound = scope.agentIds;
  return scope.kind === 'app-backend'
    ? bound !== undefined && bound.length > 0
    : bound === undefined;
}

/** A builder or app-backend scope is a person's, so it rides on an OAuth token only. */
function isKeyEndpointScope(scope: TokenScope): boolean {
  return isEndpointScope(scope.kind) && scope.kind !== 'builder' && scope.kind !== 'app-backend';
}

/**
 * Whether the scope fits the credential. A browser-token principal carries a scope and is otherwise
 * the minter's own identity; an API-key principal may carry one too, but only an endpoint scope
 * (ADR-0134), and a browser token never carries an endpoint scope, so a key's scope cannot be
 * passed off as a token's.
 */
function scopeFitsVia({ via, scope }: PrincipalShape): boolean {
  switch (via) {
    case 'browser-token':
      return scope !== null && !isEndpointScope(scope.kind);
    case 'oauth-token':
      return scope !== null && isEndpointScope(scope.kind);
    case 'api-key':
      return scope === null || isKeyEndpointScope(scope);
    default:
      return scope === null;
  }
}

/** Whether the credential kind, `via`, user id and API-key id agree with one another. */
function kindFitsVia({ kind, via, userId, apiKeyId }: PrincipalShape): boolean {
  if (kind === 'membership') {
    const membershipVias: readonly Via[] = [
      'session',
      'user-token',
      'browser-token',
      'oauth-token',
    ];
    return membershipVias.includes(via) && userId !== null && apiKeyId === null;
  }
  const keyVias: readonly Via[] = ['api-key', 'browser-token'];
  return kind === 'api_key' && keyVias.includes(via) && userId === null && apiKeyId !== null;
}

/** Whether the fields of an already-nominal, frozen principal are mutually consistent. */
export function hasConsistentFields(principal: PrincipalShape): boolean {
  if (!scopeFitsVia(principal) || !carriesBoundAgentsCorrectly(principal.scope)) return false;
  // A grant rides on an OAuth token and on nothing else.
  if ((principal.via === 'oauth-token') !== (principal.oauth !== null)) return false;
  // Only an API key may act for someone else; every other principal owns what it writes.
  if (principal.kind !== 'api_key' && principal.ownerPrincipalId !== principal.principalId) {
    return false;
  }
  return kindFitsVia(principal);
}
