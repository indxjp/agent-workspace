/**
 * `GET|PUT /api/sessions/:engineSessionId/state-blobs` — spec §20, §14.9 (ENG-06).
 *
 * The other half of a session's durable state: one opaque snapshot per `blobKey`, for an engine
 * whose conversation is files rather than a list of entries — an ACP agent replays its own state
 * directory on `session/load`. The bytes stream straight through; the handlers are
 * `apps/web/server/sessions/state-api.ts`.
 *
 * §34 does not print these, so `tests/route-declarations/ENG-06-SESSION-STATE-305.ts` carries a
 * `mandate` citing §20 for each (ADR-0026).
 */
import type { NextRequest } from 'next/server';

import { getSessionStateBlob, putSessionStateBlob } from '../../../../../server/sessions/state-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-blobs'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return getSessionStateBlob(request, engineSessionId);
}

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-blobs'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return putSessionStateBlob(request, engineSessionId);
}
