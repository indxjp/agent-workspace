import { servePlatformExport } from '../../../../../server/platforms/http';

/** `POST /api/agents/:id/platform-archives` (issue #968): the same export as a tar. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return servePlatformExport(request, context, 'tar');
}
