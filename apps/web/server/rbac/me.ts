/** `GET /api/me`: the wire projection of the principal a credential resolves to. */
import type { FeatureId } from '@indx-workspace/contracts/features';

import type { ApiResult } from '../http/result';
import type { Principal, PrincipalKind } from './principal';
import type { Role } from './core/roles';

/**
 * The wire spelling of a {@link PrincipalKind} (issue #233).
 *
 * `workspace_principals.kind` stores `api_key` under a CHECK constraint
 * (`packages/core/src/db/schema/workspace-principals.ts`), so the stored value cannot be renamed
 * without a migration; every enum `@indx-workspace/contracts` publishes is kebab-case. The two
 * therefore differ by one character and this is the single place that reconciles them.
 *
 * A total `switch` with no `default` arm: a third principal kind is a compile error here rather
 * than a value that leaks the stored spelling, or `undefined`, onto the wire.
 */
export type WirePrincipalKind = 'membership' | 'api-key';

export function wireKind(kind: PrincipalKind): WirePrincipalKind {
  switch (kind) {
    case 'membership':
      return 'membership';
    case 'api_key':
      return 'api-key';
  }
}

/**
 * The six fields `GET /api/me` publishes, and no seventh.
 *
 * Declared positively rather than derived from `Principal` by a spread or an `Omit`: the
 * `Principal` this is built from also carries `actor`, `via` and `apiKeyId`, and a
 * spread-and-serialise implementation would publish all three. A field added to `Principal`
 * tomorrow is invisible to this type by construction, and `me.test.ts` plus
 * `sdk-conformance.*.test.ts` scan the rendered JSON rather than trusting the annotation.
 */
export interface MePrincipal {
  readonly principalId: string;
  readonly kind: WirePrincipalKind;
  readonly role: Role;
  readonly workspaceId: string;
  /** `users.id` for a membership principal; `null` for exactly an API-key principal. */
  readonly userId: string | null;
  /** Display attribution — the member's name or the key's name. Never an authorization input. */
  readonly label: string;
  /** The features on for `workspaceId`, in `FEATURE_IDS` order (ADR-0160 D8). */
  readonly features: readonly FeatureId[];
}

/**
 * `GET /api/me` — the principal this credential resolves to.
 *
 * There is no failure arm and no directory read. `authorise` has already answered the only two
 * questions this route has: a caller it could not identify is `401 unauthenticated` (which is
 * what a revoked key and an expired session both are), and everything past that point carries a
 * real {@link Principal}. So this is a pure projection, and it is the whole handler. `features` is
 * what `authorise` read for the caller's workspace (ADR-0160 D8).
 */
export function readMe(principal: Principal, features: readonly FeatureId[]): ApiResult {
  const body: MePrincipal = {
    principalId: principal.principalId,
    kind: wireKind(principal.kind),
    role: principal.role,
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    label: principal.label,
    features: [...features],
  };
  return { status: 200, body };
}
