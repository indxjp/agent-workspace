/**
 * The share wire mapper, the published-content builder and the list visibility filter (W2-4,
 * F-05). They lived in `app/api/shares/route.ts`, which made tests and the SDK conformance suite
 * import a route file; the route now only wires them.
 */
import type { Role } from '../../rbac/roles';
import { exportAgentDefinition } from '../agent-definition/definition';
import { sessionTranscriptSnapshot, type SharedRun } from '../session-snapshot/snapshot';
import type { PublishShareRequest } from './input';
import type { ShareRecord } from '../store';

/** Explicit wire allowlist: persistence-only hashes and future columns cannot leak by spreading. */
export function toShareResource(share: ShareRecord, viewCount?: number) {
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
    ...(viewCount === undefined ? {} : { viewCount }),
    ...(share.visibility === 'public' ? { url: `/p/${share.token}` } : {}),
  };
}

/**
 * The content a share publishes, always through the server's secret masking: a session's
 * transcript, copied from the runs the caller chose (ADR-0158), or an agent's definition. A
 * caller-authored raw `snapshot` is never stored — it would skip the masking. The definition is
 * still caller-authored until RF-103 builds it from the stored subject.
 */
export async function publishedSnapshot(
  body: PublishShareRequest,
  materials: { readonly values: readonly string[]; readonly referenceIds: readonly string[] },
  sessionRuns: (runIds: readonly string[]) => Promise<readonly (SharedRun | null)[]>,
): Promise<unknown> {
  if (body.subjectType === 'session' && body.transcript !== undefined) {
    return sessionTranscriptSnapshot(
      body.subjectId,
      await sessionRuns(body.transcript.runIds),
      materials.values,
    );
  }
  if (body.subjectType === 'agent' && body.definition) {
    return exportAgentDefinition(body.definition, materials.values, materials.referenceIds);
  }
  return undefined;
}

/** The shares a caller may list: every share for an owner or admin, otherwise only their own. */
export function visibleShares<T extends Pick<ShareRecord, 'publisherPrincipalId'>>(
  shares: readonly T[],
  viewer: { readonly role: Role; readonly ownerPrincipalId: string },
): T[] {
  return shares.filter(
    (share) =>
      viewer.role === 'owner' ||
      viewer.role === 'admin' ||
      share.publisherPrincipalId === viewer.ownerPrincipalId,
  );
}
