/**
 * `POST /api/agents/:id/runs` — spec §34.
 *
 * Per docs/adr/0013 this task owns `apps/web/app/api/agents/[id]/runs/**` and nothing else under
 * the agents tree; the five agent CRUD routes of §34 are W1-CP-05's.
 */
import type { NextRequest } from 'next/server';

import { route } from '../../../../../server/http/route';
import { startRun } from '../../../../../server/runs/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: NextRequest,
  context: RouteContext<'/api/agents/[id]/runs'>,
): Promise<Response> {
  const { id } = await context.params;
  return startRun(request, id);
}

export const POST = route({ component: 'runs', operation: 'start' }, servePost);
