/**
 * `POST /p/s/<name>/sessions` — the hosted surface page's local session bootstrap (ADR-0105
 * slice 1; S1-17, issue #455). A thin adapter: `createSurfaceSession` in
 * `apps/web/server/surfaces/public/handlers.ts` decides everything and is tested without a server.
 */
import { toResponse } from '../../../../../server/rbac/http';
import { createSurfaceSession } from '../../../../../server/surfaces/public/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return toResponse(await createSurfaceSession(request, name));
}
