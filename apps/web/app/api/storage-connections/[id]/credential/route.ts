/**
 * `PUT /api/storage-connections/:id/credential` — replace the credential of a connection (the
 * storage design, §05; US-STO-12). The previous value is never returned.
 */
import { route } from '../../../../../server/http/route';
import { readJsonBody } from '../../../../../server/http/result';
import { authorise, readIdParam, toResponse } from '../../../../../server/rbac/http';
import {
  rotateStorageConnectionCredential,
  withStorageConnections,
} from '../../../../../server/storage-connections/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function rotateCredential(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', async ({ application, principal }) => {
      const id = await readIdParam(context);
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return withStorageConnections(application.storageConnections, (connections) =>
        rotateStorageConnectionCredential(connections, principal, id, body.value),
      );
    }),
  );
}

export const PUT = route(
  { component: 'storage-connections', operation: 'rotate' },
  rotateCredential,
);
