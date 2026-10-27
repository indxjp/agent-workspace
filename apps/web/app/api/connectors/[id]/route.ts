/**
 * `GET`, `PATCH` and `DELETE /api/connectors/:id` — spec §8. None is printed in spec §34's example
 * list (only the collection routes are), so each carries a `mandate` in
 * `tests/route-declarations/W2-CP-05.ts` (ADR-0026). `PATCH` is the field update (S-20); a body
 * that is exactly `{ credential }` is the credential rotation it has always been.
 */
import {
  deleteConnector,
  getConnector,
  connectorNotFound,
  requireConnectorId,
  isDryRunBody,
  updateConnector,
} from '../../../../server/connectors/handlers';
import {
  connectorsRuntimeNotConfigured,
  readConnectorIdParam,
  readConnectorBody,
  withWorkspaceStore,
} from '../../../../server/connectors/http';
import { apiResultResponse } from '../../../../server/http/json-transport';
import { applicationContext } from '../../../../server/application-context';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ConnectorRouteContext = { params: Promise<{ id: string }> };

function ownershipOf(id: unknown): OwnershipResolver {
  return async (principal) => {
    const parsed = requireConnectorId(id);
    const connectors = applicationContext()?.connectors;
    if (connectors?.kind !== 'serving') {
      return { kind: 'refuse', result: connectorsRuntimeNotConfigured() };
    }
    const installed = connectors.runtime;
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

export async function GET(request: Request, context: ConnectorRouteContext): Promise<Response> {
  const id = await readConnectorIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    (store) => getConnector(store, id),
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

export async function PATCH(request: Request, context: ConnectorRouteContext): Promise<Response> {
  const id = await readConnectorIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (store, audit) => {
      const body = await readConnectorBody(request);
      if (!body.ok) return body.result;
      const updated = await updateConnector(store, id, body.value);
      // A tool connector's PATCH dry run (`{ …, "dryRun": true }`) answers 200 and changes nothing.
      if (updated.status === 200 && !isDryRunBody(body.value)) {
        const connector = updated.body as { id: string; name: string };
        await audit.recordAudit({ subjectId: connector.id, subjectLabel: connector.name });
      }
      return updated;
    },
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

export async function DELETE(request: Request, context: ConnectorRouteContext): Promise<Response> {
  const id = await readConnectorIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (store, audit) => {
      const existing = typeof id === 'string' ? await store.get(id) : null;
      const deleted = await deleteConnector(store, id);
      if (deleted.status === 204 && existing !== null) {
        await audit.recordAudit({ subjectId: existing.id, subjectLabel: existing.name });
      }
      return deleted;
    },
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}
