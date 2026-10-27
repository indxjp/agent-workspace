/**
 * `GET /api/storage-connections/:id/browse?prefix=&cursor=` — list one page of a folder the
 * connection allows (the storage design, §05; US-STO-12). The handler reads the query string
 * itself, because the prefix must reach it undecoded.
 */
import { route } from '../../../../../server/http/route';
import { authorise, readIdParam, toResponse } from '../../../../../server/rbac/http';
import {
  browseStorageConnection,
  withStorageConnections,
} from '../../../../../server/storage-connections/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function browseConnection(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      return withStorageConnections(application.storageConnections, (connections) =>
        browseStorageConnection(connections, principal, id, request.url),
      );
    }),
  );
}

export const GET = route(
  { component: 'storage-connections', operation: 'browse' },
  browseConnection,
);
