/**
 * The HTTP edge of the secrets routes. Copies `apps/web/server/agents/http.ts`'s shape; see that
 * file's header for why route files stay this thin (a Next.js route file cannot be imported by a
 * test without dragging the framework's routing conventions in).
 */
import { applicationContext } from '../application-context';
import { SECRET_VALUE_MAX_LENGTH } from './contract';
import { problem, type ApiResult } from '../http/result';
import type { WorkspaceSecretsStore } from './store';
import { readBoundedJson, readRouteParam } from '../http/json-transport';

const JSON_WORST_CASE_BYTES_PER_CODE_UNIT = 6;
/** Room for the object braces, field names and whitespace around the bounded `value` field. */
const NON_VALUE_ALLOWANCE_BYTES = 4 * 1024;

/**
 * The largest request body these routes will read, in bytes. Derived from
 * {@link SECRET_VALUE_MAX_LENGTH} the same way `apps/web/server/agents/http.ts` derives its own
 * bound from `AGENT_INSTRUCTIONS_MAX_LENGTH` — loose enough that no legally-sized body is
 * rejected, tight enough that an oversized body is refused before it is held in memory.
 */
export const MAX_REQUEST_BODY_BYTES =
  SECRET_VALUE_MAX_LENGTH * JSON_WORST_CASE_BYTES_PER_CODE_UNIT + NON_VALUE_ALLOWANCE_BYTES;

/** Read and parse a JSON request body. Same five rejections as `agents/http.ts`, same reasons. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_REQUEST_BODY_BYTES, problem });
}

/**
 * Resolve the caller's workspace, hand the matching store to `run`, and return its answer. See
 * `apps/web/server/agents/http.ts`'s `withWorkspaceStore` for the full reasoning — this is the
 * same function against a different runtime.
 */
export async function withWorkspaceStore(
  request: Request,
  run: (store: WorkspaceSecretsStore) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const secrets = applicationContext()?.secrets;
  if (secrets?.kind !== 'serving') {
    return problem(
      503,
      'secrets_runtime_not_configured',
      'The secrets API has no store or workspace resolver wired into it. This deployment cannot ' +
        'serve secrets requests; it is not that the request was rejected.',
    );
  }
  const runtime = secrets.runtime;
  // A route that already passed `requireResourceAccess` hands its verified principal's workspace
  // in, so the request is not resolved a second time against a possibly different answer.
  if (authenticatedWorkspaceId !== undefined) {
    return run(runtime.secrets.forWorkspace(authenticatedWorkspaceId));
  }

  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(runtime.secrets.forWorkspace(resolution.workspaceId));
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
export async function readSecretIdParam(context: {
  params: Promise<{ id: string }>;
}): Promise<unknown> {
  return readRouteParam(context, 'id');
}
