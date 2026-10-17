/**
 * The HTTP edge of the runtime-profile and runtime-connection routes: turning a `Request` into
 * something a handler can use, and turning its answer back into a `Response`. Copies
 * `apps/web/server/agents/http.ts`'s shape; see that file's header for the reasoning behind each
 * piece (the body-size bound streamed rather than checked after buffering, the ordering of the
 * workspace gate before body parsing, and the total `switch` on `WorkspaceResolution`).
 */
import { problem, type ApiResult } from './handlers';
import type { WorkspaceRuntimeProfileStore } from './store';
import type { WorkspaceRuntimeConnectionStore } from './connections';
import { currentRuntimesRuntime } from './runtime';
import { apiResultResponse, readBoundedJson, readRouteParam } from '../http/json-transport';

/**
 * The largest request body these routes will read, in bytes. `driverConfig` is the one field with
 * no printed spec bound (§15.1 calls it "the escape hatch"), so this is a flat allowance rather
 * than a value derived from a specific field's own maximum — a declared simplification, not a
 * hidden one.
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_REQUEST_BODY_BYTES, problem });
}

export function toResponse(result: ApiResult): Response {
  return apiResultResponse(result);
}

/**
 * Resolve the caller's workspace, hand the matching runtime-profile store to `run`. See
 * `agents/http.ts`'s equivalent for why the unconfigured case is 503, and why the resolution
 * `switch` has no default that falls through to success.
 */
export async function withWorkspaceProfileStore(
  request: Request,
  run: (store: WorkspaceRuntimeProfileStore) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const runtime = currentRuntimesRuntime();
  if (runtime === null) {
    return problem(
      503,
      'runtimes_runtime_not_configured',
      'The runtime-profiles API has no store or workspace resolver wired into it. This ' +
        'deployment cannot serve runtime-profile requests; it is not that the request was rejected.',
    );
  }
  // A route that already passed `requireResourceAccess` hands its verified principal's workspace
  // in, so the request is not resolved a second time against a possibly different answer.
  if (authenticatedWorkspaceId !== undefined) {
    return run(runtime.profiles.forWorkspace(authenticatedWorkspaceId));
  }
  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(runtime.profiles.forWorkspace(resolution.workspaceId));
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

/** Same as {@link withWorkspaceProfileStore}, for the connections store. */
export async function withWorkspaceConnectionStore(
  request: Request,
  run: (store: WorkspaceRuntimeConnectionStore) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const runtime = currentRuntimesRuntime();
  if (runtime === null) {
    return problem(
      503,
      'runtimes_runtime_not_configured',
      'The runtime-connections API has no store or workspace resolver wired into it. This ' +
        'deployment cannot serve runtime-connection requests; it is not that the request was rejected.',
    );
  }
  // A route that already passed `requireResourceAccess` hands its verified principal's workspace
  // in, so the request is not resolved a second time against a possibly different answer.
  if (authenticatedWorkspaceId !== undefined) {
    return run(runtime.connections.forWorkspace(authenticatedWorkspaceId));
  }
  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(runtime.connections.forWorkspace(resolution.workspaceId));
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

/** Read `params` from a Next.js dynamic segment without assuming it resolved to what it should. */
export async function readIdParam(context: { params: Promise<{ id: string }> }): Promise<unknown> {
  return readRouteParam(context, 'id');
}
