/**
 * `GET /api/runs/:id` — spec §34.
 *
 * A five-line adapter. The handler is `apps/web/server/runs/api.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../server/http/error-response';
import { readRun, revokeRunTokens } from '../../../../server/runs/api';

// Valid while Cache Components is off. A route handler that streams or reads a request must not
// be prerendered; `force-dynamic` says so, and R-13 notes `fetchCache = 'force-no-store'` would
// be redundant beside it.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await readRun(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'read' });
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await revokeRunTokens(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'revoke-tokens' });
  }
}
