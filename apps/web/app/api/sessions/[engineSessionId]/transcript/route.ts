/**
 * `GET|POST|DELETE /api/sessions/:engineSessionId/transcript` — spec §20, §14.9.
 *
 * The durable half of a session: the Agent SDK's transcript entries, which §14.9 requires the
 * `SessionStore` to persist *"not only the session id"*. Three five-line adapters; the handlers
 * are `apps/web/server/sessions/api.ts`.
 *
 * §34 does not print these three, so `tests/route-declarations/W2-CP-07.ts` carries a `mandate`
 * citing §20 for each (ADR-0026).
 */
import type { NextRequest } from 'next/server';

import {
  appendTranscript,
  deleteTranscript,
  loadTranscript,
} from '../../../../../server/sessions/api';

// Valid while Cache Components is off. A transcript read is per-request and per-tenant, and must
// never be prerendered or cached.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the session store needs Node APIs.
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/transcript'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return loadTranscript(request, engineSessionId);
}

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/transcript'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return appendTranscript(request, engineSessionId);
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/transcript'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return deleteTranscript(request, engineSessionId);
}
