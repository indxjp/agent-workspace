/**
 * `GET /api/agents/:id/feedback` — issue #620: the newest ratings of an agent's runs.
 *
 * A five-line adapter. The handler is `listAgentFeedback` in `apps/web/server/runs/feedback.ts`,
 * which is a plain `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { listAgentFeedback } from '../../../../../server/runs/feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/agents/[id]/feedback'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await listAgentFeedback(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'list-feedback' });
  }
}
