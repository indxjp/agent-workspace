/**
 * `POST /api/runs/:id/feedback` — issue #539 (S2-05c, C19).
 *
 * A five-line adapter. The handler is `apps/web/server/runs/feedback.ts`, which is a plain
 * `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { submitRunFeedback } from '../../../../../server/runs/feedback';

// Valid while Cache Components is off. A route handler that reads a request must not be
// prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/feedback'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await submitRunFeedback(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'feedback' });
  }
}
