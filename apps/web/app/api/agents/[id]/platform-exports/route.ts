import { servePlatformExport } from '../../../../../server/platforms/http';

/**
 * `POST /api/agents/:id/platform-exports` (issue #968): one stored version, compiled for one
 * platform, answered as JSON files and a verdict report. Everything is in `server/platforms/`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return servePlatformExport(request, context, 'json');
}
