/**
 * `POST /api/runs/:id/interrupt` — issue #235 (S-14).
 *
 * A five-line adapter. The handler is `apps/web/server/runs/api.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { interruptRun } from '../../../../../server/runs/api';

// Valid while Cache Components is off. A route handler that reads a request must not be
// prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/interrupt'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await interruptRun(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'interrupt' });
  }
}
