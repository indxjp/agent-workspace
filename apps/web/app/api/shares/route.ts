import {
  requireShareAccess,
  shareJson,
  shareProblem,
  withShares,
} from '../../../server/shares/core/http';
import { ownerPrincipalIdOf } from '../../../server/rbac/owner-principal';
import {
  parsePublishShareRequest,
  type PublishShareRequest,
} from '../../../server/shares/core/input';
import { createSessionSnapshot } from '../../../server/shares/session-snapshot/snapshot';
import { exportAgentDefinition } from '../../../server/shares/agent-definition/definition';
import type { ShareRecord } from '@agent-workspace/core/db';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { errorResponse } from '../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
 * transcript or an agent's definition. A caller-authored raw `snapshot` is never stored — it would
 * skip the masking. The transcript and definition themselves are still caller-authored until
 * RF-103 builds them from the stored subject.
 */
export function publishedSnapshot(
  body: PublishShareRequest,
  materials: { readonly values: readonly string[]; readonly referenceIds: readonly string[] },
): unknown {
  if (body.subjectType === 'session' && Array.isArray(body.transcript)) {
    return createSessionSnapshot(body.transcript, materials.values, {
      technicalDetails: body.include?.technicalDetails === true,
      outputFiles: body.include?.outputFiles === true,
    });
  }
  if (body.subjectType === 'agent' && body.definition) {
    return exportAgentDefinition(body.definition, materials.values, materials.referenceIds);
  }
  return undefined;
}
export async function GET(request: Request) {
  try {
    return await withShares(request, async ({ sharing, actor }) => {
      const access = await requireShareAccess(request, actor);
      if (!access.ok) return access.response;
      const visible = (await sharing.shares.list()).filter(
        (share) =>
          access.principal.role === 'owner' ||
          access.principal.role === 'admin' ||
          share.publisherPrincipalId === ownerPrincipalIdOf(actor),
      );
      return Response.json({
        shares: await Promise.all(
          visible.map(async (share) => toShareResource(share, await sharing.views.count(share.id))),
        ),
      });
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'list' });
  }
}
export async function POST(request: Request) {
  try {
    return await withShares(request, async (context) => {
      const body = parsePublishShareRequest(await shareJson(request));
      const ownership = await context.subjectOwnership(body.subjectType, body.subjectId);
      const access = await requireResourceAccess(request, ownership);
      if (!access.ok) return access.response;
      if (access.principal.workspaceId !== context.actor.workspaceId)
        return shareProblem(
          403,
          'forbidden',
          'The authorisation identity resolved another workspace.',
        );
      const snapshot = publishedSnapshot(body, await context.sharingMaterials());
      const share = await context.service.publish({ ...body, snapshot }, context.actor);
      return Response.json(toShareResource(share), { status: 201 });
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'publish' });
  }
}
