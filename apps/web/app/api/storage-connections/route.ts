/**
 * `GET`/`POST /api/storage-connections` — list and connect a bucket or folder (the storage design,
 * §05; US-STO-12). A collection route names no single row, so `ownership` is `'not-applicable'`.
 */
import { route } from '../../../server/http/route';
import { readJsonBody } from '../../../server/http/result';
import { authorise, toResponse } from '../../../server/rbac/http';
import {
  createStorageConnection,
  listStorageConnections,
  withStorageConnections,
} from '../../../server/storage-connections/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function listConnections(request: Request): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', ({ application, principal }) =>
      withStorageConnections(application.storageConnections, (connections) =>
        listStorageConnections(connections, principal),
      ),
    ),
  );
}

async function connect(request: Request): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return withStorageConnections(application.storageConnections, (connections) =>
        createStorageConnection(connections, principal, body.value),
      );
    }),
  );
}

export const GET = route({ component: 'storage-connections', operation: 'list' }, listConnections);
export const POST = route({ component: 'storage-connections', operation: 'create' }, connect);
