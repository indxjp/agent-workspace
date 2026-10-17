/**
 * `GET`/`PATCH`/`DELETE /api/endpoint-clients/:id` — issue #949, ADR-0134. `DELETE` revokes the
 * client and every key bound to it; the row stays so the revocation is auditable.
 */
import { get, revoke, update } from '../../../../server/endpoint-clients/handlers';
import { readIdParam, toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return toResponse(await get(request, await readIdParam(context)));
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return toResponse(await update(request, await readIdParam(context)));
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return toResponse(await revoke(request, await readIdParam(context)));
}
