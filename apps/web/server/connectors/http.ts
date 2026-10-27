/**
 * The HTTP edge of the connector routes. Copies `apps/web/server/secrets/http.ts`'s shape; see
 * that file's header for why route files stay thin (a Next.js route file cannot be imported by a
 * test without dragging the framework's routing conventions in).
 */
import {
  CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND,
  OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES,
} from '@indx-workspace/contracts/connectors';

import { applicationContext } from '../application-context';
import { connectorKindOfBody } from './contract';
import { problem, type ApiResult } from '../http/result';
import type { WorkspaceConnectorsProbeSource, WorkspaceConnectorsStore } from './store';
import { readRouteParam, readSizedJson } from '../http/json-transport';

/**
 * Read and parse a connector JSON request body (C15): read up to the largest per-kind cap, then
 * apply the cap of the body's own kind, so the 2 MiB `openapi` allowance is that kind's only. An
 * unknown kind is held to the `mcp` cap (its refusal comes after). Same rejections as
 * `agents/http.ts` and `secrets/http.ts` otherwise.
 */
export async function readConnectorBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const read = await readSizedJson(request, {
    maxBytes: OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES,
    problem,
  });
  if (!read.ok) return read;
  const cap = CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND[connectorKindOfBody(read.value) ?? 'mcp'];
  if (read.bytes > cap) {
    return {
      ok: false,
      result: problem(
        413,
        'request_body_too_large',
        `This route reads at most ${String(cap)} bytes of request body for this connector kind; the request sent ${String(read.bytes)}.`,
      ),
    };
  }
  return { ok: true, value: read.value };
}

export const connectorsRuntimeNotConfigured = (): ApiResult =>
  problem(
    503,
    'connectors_runtime_not_configured',
    'The connectors API has no store or workspace resolver wired into it. This deployment cannot ' +
      'serve connector requests; it is not that the request was rejected.',
  );

/** Resolve the caller's workspace, hand the matching CRUD store to `run`, and return its answer. */
export async function withWorkspaceStore(
  request: Request,
  run: (
    store: WorkspaceConnectorsStore,
    context: {
      recordAudit(event: Readonly<{ subjectId: string; subjectLabel: string }>): Promise<void>;
      readonly workspaceId: string;
      /** issue #117: `memberships.user_id` of the caller, or `null` — see `ConnectorsRuntime`'s
       *  own comment on `identifyActor` for why a route needs this to stamp `created_by`. */
      identifyActor(): ReturnType<import('./runtime').ConnectorsRuntime['identifyActor']>;
    },
  ) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const connectors = applicationContext()?.connectors;
  if (connectors?.kind !== 'serving') return connectorsRuntimeNotConfigured();
  const runtime = connectors.runtime;

  if (authenticatedWorkspaceId !== undefined) {
    return run(runtime.connectors.forWorkspace(authenticatedWorkspaceId), {
      recordAudit: (event) => runtime.recordAudit(request, event),
      workspaceId: authenticatedWorkspaceId,
      identifyActor: () => runtime.identifyActor(request),
    });
  }

  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(runtime.connectors.forWorkspace(resolution.workspaceId), {
        recordAudit: (event) => runtime.recordAudit(request, event),
        workspaceId: resolution.workspaceId,
        identifyActor: () => runtime.identifyActor(request),
      });
    case 'unauthenticated':
      return problem(401, 'unauthenticated', resolution.reason);
    case 'forbidden':
      return problem(403, 'forbidden', resolution.reason);
    default: {
      const unreachable: never = resolution;
      return problem(
        500,
        'unhandled_workspace_resolution',
        `The workspace resolver returned a case this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** Resolve the caller's workspace, hand the wider probe-capable store to `run`. Only the
 *  test-connection route calls this — see `store.ts`'s header for why the two are kept apart. */
export async function withWorkspaceProbeStore(
  request: Request,
  run: (store: WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const connectors = applicationContext()?.connectors;
  if (connectors?.kind !== 'serving') return connectorsRuntimeNotConfigured();
  const runtime = connectors.runtime;

  if (authenticatedWorkspaceId !== undefined) {
    return run(runtime.connectors.forWorkspace(authenticatedWorkspaceId));
  }

  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(runtime.connectors.forWorkspace(resolution.workspaceId));
    case 'unauthenticated':
      return problem(401, 'unauthenticated', resolution.reason);
    case 'forbidden':
      return problem(403, 'forbidden', resolution.reason);
    default: {
      const unreachable: never = resolution;
      return problem(
        500,
        'unhandled_workspace_resolution',
        `The workspace resolver returned a case this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** Read `params` from a Next.js dynamic segment, without assuming it resolved to what it should. */
export async function readConnectorIdParam(context: {
  params: Promise<{ id: string }>;
}): Promise<unknown> {
  return readRouteParam(context, 'id');
}
