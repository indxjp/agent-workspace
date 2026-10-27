/**
 * `GET`/`PATCH`/`DELETE /api/storage-connections/:id` — read, edit or remove one connection of the
 * caller's workspace; a connection of another workspace is `404`. `ownership` is `'not-applicable'`:
 * the `storage-connections` grant is workspace-wide, so no row is read to decide.
 */
import { route } from '../../../../server/http/route';
import { readJsonBody } from '../../../../server/http/result';
import { authorise, readIdParam, toResponse } from '../../../../server/rbac/http';
import {
  deleteStorageConnection,
  getStorageConnection,
  updateStorageConnection,
  withStorageConnections,
} from '../../../../server/storage-connections/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function readConnection(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      return withStorageConnections(application.storageConnections, (connections) =>
        getStorageConnection(connections, principal, id),
      );
    }),
  );
}

async function editConnection(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return withStorageConnections(application.storageConnections, (connections) =>
        updateStorageConnection(connections, principal, id, body.value),
      );
    }),
  );
}

async function removeConnection(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      return withStorageConnections(application.storageConnections, (connections) =>
        deleteStorageConnection(connections, principal, id),
      );
    }),
  );
}

export const GET = route({ component: 'storage-connections', operation: 'get' }, readConnection);
export const PATCH = route(
  { component: 'storage-connections', operation: 'update' },
  editConnection,
);
export const DELETE = route(
  { component: 'storage-connections', operation: 'delete' },
  removeConnection,
);
