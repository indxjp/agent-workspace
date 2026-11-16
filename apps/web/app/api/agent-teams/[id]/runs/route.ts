/**
 * `POST /api/agent-teams/:id/runs` — ADR-0104 acceptance decisions 4 and 11, issue #1517, spec 04
 * §5.18. Starts the team's newest version on its lead and answers `202` like a run start.
 */
import type { NextRequest } from 'next/server';

import { startAgentTeamRun } from '../../../../../server/agent-teams/team-run';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: NextRequest,
  context: RouteContext<'/api/agent-teams/[id]/runs'>,
): Promise<Response> {
  const { id } = await context.params;
  return startAgentTeamRun(request, id);
}

export const POST = route({ component: 'agent-teams', operation: 'run' }, servePost);
