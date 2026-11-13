/**
 * The share wire mapper and the list visibility filter (W2-4, F-05). They lived in
 * `app/api/shares/route.ts`, which made tests and the SDK conformance suite import a route file;
 * the route now only wires them. The published-content builder reads other domains, so it is in
 * `../publish-request.ts`.
 */

/** The stored share fields the wire mapper reads; the store's `ShareRecord` has them all. */
export interface ShareWireFields {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly visibility: string;
  readonly mode: string | null;
  readonly snapshot: unknown;
  readonly include: unknown;
  readonly budgetCapUsd: string | null;
  readonly spentUsd: string;
  readonly stopped: boolean;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly createdAt: Date;
}

/** Explicit wire allowlist: persistence-only hashes and future columns cannot leak by spreading. */
function shareFields(share: ShareWireFields) {
  return {
    id: share.id,
    subjectType: share.subjectType,
    subjectId: share.subjectId,
    subjectLabel: share.subjectLabel,
    visibility: share.visibility,
    mode: share.mode,
    snapshot: share.snapshot,
    include: share.include,
    budgetCapUsd: share.budgetCapUsd,
    spentUsd: share.spentUsd,
    stopped: share.stopped,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    revokedAt: share.revokedAt?.toISOString() ?? null,
    suspendedAt: share.suspendedAt?.toISOString() ?? null,
    createdAt: share.createdAt.toISOString(),
  };
}

/**
 * The `201` of `POST /api/shares`: the one response that carries a public link (`/p/<token>`).
 * The token is minted by the publish and never stored (part 06 step 3 phase 2), so this is the
 * only time the link can be shown.
 */
export function toShareResource(share: ShareWireFields, token: string) {
  return {
    ...shareFields(share),
    ...(share.visibility === 'public' ? { url: `/p/${token}` } : {}),
  };
}

/** One item of `GET /api/shares`: the share and its view count, never a link. */
export function toShareListItem(share: ShareWireFields, viewCount: number) {
  return { ...shareFields(share), viewCount };
}

/** The shares a caller may list: every share for an owner or admin, otherwise only their own. */
export function visibleShares<T extends { readonly publisherPrincipalId: string }>(
  shares: readonly T[],
  viewer: { readonly role: string; readonly ownerPrincipalId: string },
): T[] {
  return shares.filter(
    (share) =>
      viewer.role === 'owner' ||
      viewer.role === 'admin' ||
      share.publisherPrincipalId === viewer.ownerPrincipalId,
  );
}
