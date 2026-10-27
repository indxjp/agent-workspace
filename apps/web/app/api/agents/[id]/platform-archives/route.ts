import { servePlatformExport } from '../../../../../server/platforms/http';
import { route } from '../../../../../server/http/route';

/** `POST /api/agents/:id/platform-archives` (issue #968): the same export as a tar. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return servePlatformExport(request, context, 'tar');
}

export const POST = route({ component: 'platforms', operation: 'export-archive' }, servePost);
