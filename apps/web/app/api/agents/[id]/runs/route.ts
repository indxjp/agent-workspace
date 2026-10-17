/**
 * `POST /api/agents/:id/runs` — spec §34.
 *
 * Per docs/adr/0013 this task owns `apps/web/app/api/agents/[id]/runs/**` and nothing else under
 * the agents tree; the five agent CRUD routes of §34 are W1-CP-05's.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { startRun } from '../../../../../server/runs/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/agents/[id]/runs'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await startRun(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'start' });
  }
}
