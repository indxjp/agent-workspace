import { servePlatformExport } from '../../../../../server/platforms/http';
import { route } from '../../../../../server/http/route';

/**
 * `POST /api/agents/:id/platform-exports` (issue #968): one stored version, compiled for one
 * platform, answered as JSON files and a verdict report. Everything is in `server/platforms/`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return servePlatformExport(request, context, 'json');
}

export const POST = route({ component: 'platforms', operation: 'export' }, servePost);
