import { RUN_START_PROBLEM_CODES } from '@indx-workspace/contracts/runs';

import { DomainError } from '../../../../server/errors';
import { currentWebRuntimeRegistry } from '../../../../server/runtimes/registry';
import { errorResponse } from '../../../../server/http/error-response';
import { requireResourceAccess } from '../../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RuntimeRouteContext = { params: Promise<{ id: string }> };

/**
 * `POST /api/runtimes/test` — start a sandbox through the named driver and echo through it.
 *
 * Issue #388: this spins up real sandbox infrastructure, so the caller is authenticated and
 * authorised before anything else — before the operation name, the registry or the body is looked
 * at. §21 grants runtimes to Owner and Admin only (`permissions.ts`: `MANAGE`); every other role,
 * and a request with no verified credential, is refused here. Nothing upstream is a substitute:
 * `apps/web/proxy.ts` checks only a credential's shape, never that it is valid.
 */
export async function POST(request: Request, context: RuntimeRouteContext): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const { id } = await context.params;
  if (id !== 'test') {
    return Response.json(
      { error: 'runtime_operation_not_found', message: `Unknown runtime operation: ${id}.` },
      { status: 404 },
    );
  }
  const registry = currentWebRuntimeRegistry();
  if (registry === null) {
    return Response.json(
      {
        error: 'runtime_registry_not_configured',
        message: 'The runtime registry is not configured.',
      },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'invalid_json', message: 'A JSON object is required.' },
      { status: 400 },
    );
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json(
      { error: 'invalid_body', message: 'A JSON object is required.' },
      { status: 400 },
    );
  }
  const record = body as Record<string, unknown>;
  if (typeof record['driver'] !== 'string' || record['driver'].length === 0) {
    return Response.json(
      { error: 'invalid_driver', message: 'driver must be a non-empty string.' },
      { status: 400 },
    );
  }
  const connectionId = record['runtimeConnectionId'];
  if (connectionId !== undefined && (typeof connectionId !== 'string' || connectionId === '')) {
    return Response.json(
      { error: 'invalid_body', message: 'runtimeConnectionId must be a non-empty string.' },
      { status: 400 },
    );
  }
  const echo = typeof record['echo'] === 'string' ? record['echo'] : 'agent-workspace runtime test';
  try {
    return Response.json(
      await registry.test(record['driver'], echo, {
        workspaceId: access.principal.workspaceId,
        ...(connectionId === undefined ? {} : { runtimeConnectionId: connectionId }),
      }),
    );
  } catch (error) {
    // The two connection refusals are the contract's `422` configuration codes (RUN_START_PROBLEM_CODES),
    // the same ones a run start answers; every other domain failure keeps its category's status.
    if (
      error instanceof DomainError &&
      (error.code === 'runtime_connection_missing' ||
        error.code === 'runtime_connection_credential_unavailable')
    ) {
      return Response.json(
        { error: { code: error.code, message: error.publicMessage } },
        { status: RUN_START_PROBLEM_CODES[error.code] },
      );
    }
    return errorResponse(error, {
      component: 'runtimes',
      operation: 'test-runtime',
      failureKind: 'upstream',
      retryable: true,
    });
  }
}
