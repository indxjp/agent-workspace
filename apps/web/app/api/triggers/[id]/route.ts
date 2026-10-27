/**
 * `GET`/`PATCH`/`DELETE /api/triggers/:id` — issue #1293, ADR-0144. `DELETE` also removes the
 * trigger's delivery records.
 */
import { readIdParam, toResponse } from '../../../../server/rbac/http';
import { get, remove, update } from '../../../../server/triggers/handlers';

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
  return toResponse(await remove(request, await readIdParam(context)));
}
