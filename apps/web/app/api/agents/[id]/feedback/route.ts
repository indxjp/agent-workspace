/**
 * `GET /api/agents/:id/feedback` — issue #620: the newest ratings of an agent's runs.
 *
 * A five-line adapter. The handler is `listAgentFeedback` in `apps/web/server/runs/feedback.ts`,
 * which is a plain `Request` -> `Response` function and is tested without a server.
 */
import type { NextRequest } from 'next/server';

import { route } from '../../../../../server/http/route';
import { listAgentFeedback } from '../../../../../server/runs/feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serveGet(
  request: NextRequest,
  context: RouteContext<'/api/agents/[id]/feedback'>,
): Promise<Response> {
  const { id } = await context.params;
  return listAgentFeedback(request, id);
}

export const GET = route({ component: 'runs', operation: 'list-feedback' }, serveGet);
