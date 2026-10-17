/**
 * `GET`/`POST /api/endpoint-clients` — issue #949, ADR-0134. A five-line adapter over
 * `apps/web/server/endpoint-clients/handlers.ts`, which is tested without a server.
 */
import { create, list } from '../../../server/endpoint-clients/handlers';
import { toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return toResponse(await list(request));
}

export async function POST(request: Request): Promise<Response> {
  return toResponse(await create(request));
}
