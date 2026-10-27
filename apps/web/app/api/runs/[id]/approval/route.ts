/**
 * `POST /api/runs/:id/approval` — ADR-0145 (P5-4, #1301).
 *
 * A five-line adapter. The handler is `apps/web/server/runs/approval.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { decideRunApproval } from '../../../../../server/runs/approval';

// Valid while Cache Components is off. A route handler that reads a request must not be
// prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/approval'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await decideRunApproval(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'approval' });
  }
}
