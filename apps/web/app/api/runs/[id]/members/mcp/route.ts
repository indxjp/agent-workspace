/**
 * `POST /api/runs/:id/members/mcp` — a team lead run's member tools, called by the lead run's
 * engine with the lead run's own run token (ADR-0104 acceptance decision 4, issue #1517). The
 * logic is `server/agent-teams/member-tools.ts`.
 */
import type { NextRequest } from 'next/server';

import { serveLeadRunMembers } from '../../../../../../server/agent-teams/member-tools';
import { route } from '../../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/members/mcp'>,
): Promise<Response> {
  const { id } = await context.params;
  return serveLeadRunMembers(request, id);
}

export const POST = route({ component: 'agent-teams', operation: 'members' }, servePost);
