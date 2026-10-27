import { requireResourceAccess, type ResourceAccess } from '../../resources/authorise';
import { problemBody } from '../../http/result';
import { ownerPrincipalIdOf } from '../../rbac/owner-principal';
import { DomainError } from '../../errors';
import { ShareService } from './service';
import { applicationContext } from '../../application-context';
import type { ShareActor, SharesRuntime, WorkspaceSharing } from './runtime';
import type { SharedRun } from '../session-snapshot/snapshot';

export function shareProblem(status: number, code: string, message: string): Response {
  return Response.json(problemBody(code, message), { status });
}
export async function shareJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new DomainError({
      category: 'validation',
      code: 'invalid_share',
      publicMessage: 'This endpoint accepts application/json.',
    });
  }
  try {
    return await request.json();
  } catch (cause) {
    throw new DomainError({
      category: 'validation',
      code: 'invalid_share',
      publicMessage: 'The request body is not valid JSON.',
      cause,
    });
  }
}
export async function withShares(
  request: Request,
  fn: (context: {
    actor: Extract<ShareActor, { kind: 'workspace' }>;
    sharing: WorkspaceSharing;
    service: ShareService;
    sharingMaterials(): Promise<{ values: readonly string[]; referenceIds: readonly string[] }>;
    sessionRuns: (runIds: readonly string[]) => Promise<readonly (SharedRun | null)[]>;
    subjectOwnership(
      subjectType: unknown,
      subjectId: unknown,
    ): Promise<import('../../rbac/decide').Ownership>;
  }) => Promise<Response> | Response,
): Promise<Response> {
  const runtime = applicationContext()?.shares;
  if (!runtime)
    return shareProblem(503, 'shares_runtime_not_configured', 'The sharing API is not configured.');
  const actor = await runtime.resolveActor(request);
  if (actor.kind === 'unauthenticated') return shareProblem(401, 'unauthenticated', actor.reason);
  if (actor.kind === 'forbidden') return shareProblem(403, 'forbidden', actor.reason);
  const sharing = await runtime.forWorkspace(actor.workspaceId);
  return fn({
    actor,
    sharing,
    service: new ShareService(sharing),
    sharingMaterials: () => runtime.sharingMaterials(actor.workspaceId),
    sessionRuns: (runIds) => runtime.sessionRuns(actor.workspaceId, runIds),
    subjectOwnership: (subjectType, subjectId) =>
      runtime.subjectOwnership({
        workspaceId: actor.workspaceId,
        principalId: ownerPrincipalIdOf(actor),
        subjectType,
        subjectId,
      }),
  });
}
export async function requireShareAccess(
  request: Request,
  actor: Extract<ShareActor, { kind: 'workspace' }>,
  publisherPrincipalId?: string,
): Promise<ResourceAccess> {
  const access = await requireResourceAccess(
    request,
    publisherPrincipalId === undefined
      ? 'not-applicable'
      : publisherPrincipalId === ownerPrincipalIdOf(actor)
        ? 'own'
        : 'other',
  );
  if (!access.ok || access.principal.workspaceId === actor.workspaceId) return access;
  return {
    ok: false,
    response: shareProblem(
      403,
      'forbidden',
      'The authorisation identity resolved another workspace.',
    ),
  };
}
export async function withPublicShare(
  token: string,
  fn: (context: {
    workspaceId: string;
    sharing: WorkspaceSharing;
    service: ShareService;
    runPublic: SharesRuntime['runPublic'];
  }) => Promise<Response> | Response,
): Promise<Response> {
  const runtime = applicationContext()?.shares;
  if (!runtime)
    return shareProblem(503, 'shares_runtime_not_configured', 'The sharing API is not configured.');
  const resolved = await runtime.resolvePublic(token);
  if (!resolved) return shareProblem(404, 'share_not_found', 'Public link not found.');
  return fn({
    ...resolved,
    service: new ShareService(resolved.sharing),
    runPublic: (input) => runtime.runPublic(input),
  });
}
