/**
 * `GET /api/sessions` — spec §34, §20.
 *
 * A five-line adapter. The handler is `apps/web/server/sessions/api.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { listSessions } from '../../../server/sessions/api';

// Valid while Cache Components is off. A handler that reads per-request credentials must not be
// prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the session store needs Node APIs.
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  return listSessions(request);
}
