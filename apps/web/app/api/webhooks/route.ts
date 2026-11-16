/**
 * `GET`/`POST /api/webhooks` — N-3 (issue #250, ADR-SDK-18-N3-250). A thin adapter over
 * `apps/web/server/webhooks/handlers.ts`, which is tested without a server.
 */
import { route } from '../../../server/http/route';
import { toResponse } from '../../../server/rbac/http';
import { create, list } from '../../../server/webhooks/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serveList(request: Request): Promise<Response> {
  return toResponse(await list(request));
}

async function serveCreate(request: Request): Promise<Response> {
  return toResponse(await create(request));
}

export const GET = route({ component: 'webhooks', operation: 'list' }, serveList);
export const POST = route({ component: 'webhooks', operation: 'create' }, serveCreate);
