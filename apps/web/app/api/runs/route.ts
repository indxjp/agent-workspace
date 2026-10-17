/**
 * `GET /api/runs` — spec §35 (issue #135).
 *
 * A five-line adapter. The handler is `apps/web/server/runs/api.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../server/http/error-response';
import { listRuns } from '../../../server/runs/api';

// Valid while Cache Components is off. A route handler that reads per-request credentials must
// not be prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await listRuns(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'list' });
  }
}
