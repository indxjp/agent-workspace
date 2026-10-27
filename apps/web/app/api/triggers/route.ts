/**
 * `GET`/`POST /api/triggers` — issue #1293, ADR-0144. A thin adapter over
 * `apps/web/server/triggers/handlers.ts`, which is tested without a server.
 */
import { toResponse } from '../../../server/rbac/http';
import { create, list } from '../../../server/triggers/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return toResponse(await list(request));
}

export async function POST(request: Request): Promise<Response> {
  return toResponse(await create(request));
}
