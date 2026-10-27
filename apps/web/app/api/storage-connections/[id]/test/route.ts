/**
 * `POST /api/storage-connections/:id/test` — open the connection with its stored credential and
 * list one page of an allowed folder (the storage design, §05; US-STO-12). The answer is the
 * outcome, never the provider's words. Testing reads the connection, so `parseOperation` in
 * `server/rbac/decide.ts` gives it the `read` a Member holds and a Viewer does not.
 */
import { route } from '../../../../../server/http/route';
import { authorise, readIdParam, toResponse } from '../../../../../server/rbac/http';
import {
  testStorageConnection,
  withStorageConnections,
} from '../../../../../server/storage-connections/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function testConnection(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      return withStorageConnections(application.storageConnections, (connections) =>
        testStorageConnection(connections, principal, id),
      );
    }),
  );
}

export const POST = route({ component: 'storage-connections', operation: 'test' }, testConnection);
