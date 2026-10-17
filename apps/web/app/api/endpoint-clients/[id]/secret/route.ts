/**
 * `POST /api/endpoint-clients/:id/secret` — issue #971, ADR-0134 part 3. Rotates the client's OAuth
 * secret; the plaintext is in this response and nowhere else.
 */
import { rotateSecret } from '../../../../../server/endpoint-clients/handlers';
import { readIdParam, toResponse } from '../../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(await rotateSecret(request, await readIdParam(context)));
}
