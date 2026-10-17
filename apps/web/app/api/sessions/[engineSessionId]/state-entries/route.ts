/**
 * `GET|POST|PUT|DELETE /api/sessions/:engineSessionId/state-entries` — spec §20, §14.9 (ENG-06).
 *
 * The engine-neutral half of a session's durable state: one stream of opaque entries per
 * `(session, engine, streamKey)`. Four five-line adapters; the handlers are
 * `apps/web/server/sessions/state-api.ts`, whose header explains why the stream key is a query
 * parameter rather than a fifth path segment and why the path id may be either session identity.
 *
 * §34 does not print these, so `tests/route-declarations/ENG-06-SESSION-STATE-305.ts` carries a
 * `mandate` citing §20 for each (ADR-0026).
 */
import type { NextRequest } from 'next/server';

import {
  appendSessionState,
  deleteSessionState,
  listSessionStateEntries,
  replaceSessionState,
} from '../../../../../server/sessions/state-api';

// Valid while Cache Components is off. Session state is per-request and per-tenant, and must never
// be prerendered or cached.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the session store needs Node APIs.
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-entries'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return listSessionStateEntries(request, engineSessionId);
}

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-entries'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return appendSessionState(request, engineSessionId);
}

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-entries'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return replaceSessionState(request, engineSessionId);
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-entries'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return deleteSessionState(request, engineSessionId);
}
