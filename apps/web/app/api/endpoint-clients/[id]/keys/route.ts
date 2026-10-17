/**
 * `POST /api/endpoint-clients/:id/keys` — issue #949, ADR-0134. Mints an endpoint-scoped API key;
 * the plaintext is in this response and nowhere else.
 */
import { mintKey } from '../../../../../server/endpoint-clients/handlers';
import { readIdParam, toResponse } from '../../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(await mintKey(request, await readIdParam(context)));
}
