/**
 * `POST /api/connectors/:id/test-connection` — re-test a SAVED connector, resolving its stored
 * secret reference server-side (spec §8, §23). Not printed in spec §34's example list, so it
 * carries a `mandate` in `tests/route-declarations/W2-CP-05.ts` (ADR-0026); `test-connection` is
 * also a sub-resource of `:id` that §34 does not print, so it is additionally declared in
 * `apps/web/server/rbac/declarations/W2-CP-05.ts` (ADR-0040).
 */
import {
  connectorNotFound,
  requireConnectorId,
  testConnectionSaved,
} from '../../../../../server/connectors/handlers';
import {
  connectorsRuntimeNotConfigured,
  readConnectorIdParam,
  toResponse,
  withWorkspaceProbeStore,
} from '../../../../../server/connectors/http';
import { currentConnectorsRuntime } from '../../../../../server/connectors/runtime';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ConnectorRouteContext = { params: Promise<{ id: string }> };

function ownershipOf(id: unknown): OwnershipResolver {
  return async (principal) => {
    const parsed = requireConnectorId(id);
    const installed = currentConnectorsRuntime();
    if (installed === null) {
      return { kind: 'refuse', result: connectorsRuntimeNotConfigured() };
    }
    if (!parsed.ok) {
      return { kind: 'refuse', result: connectorNotFound() };
    }
    const connector = await installed.connectors.forWorkspace(principal.workspaceId).get(parsed.id);
    if (connector === null) return { kind: 'refuse', result: connectorNotFound() };
    return {
      kind: 'ownership',
      ownership: connector.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other',
    };
  };
}

export async function POST(request: Request, context: ConnectorRouteContext): Promise<Response> {
  const id = await readConnectorIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceProbeStore(
    request,
    (store) => testConnectionSaved(store, id),
    access.principal.workspaceId,
  );
  return toResponse(result);
}
