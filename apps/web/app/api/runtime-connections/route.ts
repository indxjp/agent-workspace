/**
 * `POST /api/runtime-connections` and `GET /api/runtime-connections`.
 *
 * Not printed in spec §34's example list, so both carry a `mandate` in
 * `tests/route-declarations/W3-CP-06.ts` citing §14.9 (ADR-0026). See
 * `apps/web/server/runtimes/connections.ts`'s header for why this resource has no table of its own.
 */
import {
  createRuntimeConnection,
  listRuntimeConnections,
} from '../../../server/runtimes/connections';
import {
  readJsonBody,
  toResponse,
  withWorkspaceConnectionStore,
} from '../../../server/runtimes/http';
import { requireResourceAccess } from '../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Issue #388: both methods are gated by the shared decision table first. A runtime connection is
// credential-bearing configuration, which §21 grants to Owner and Admin only (`permissions.ts`:
// `MANAGE`); `resolveWorkspace` alone answers only "which workspace", never "may this role".

/** `GET /api/runtime-connections` — the caller's workspace's connections, never a credential. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceConnectionStore(
    request,
    (store) => listRuntimeConnections(store),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/** `POST /api/runtime-connections` — create one connection in the caller's workspace (§14.9). */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceConnectionStore(
    request,
    async (store) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return createRuntimeConnection(store, body.value);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
