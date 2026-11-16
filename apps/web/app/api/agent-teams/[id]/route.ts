/**
 * `GET`/`DELETE /api/agent-teams/:id` — ADR-0104 acceptance, issue #1516, spec 04 §5.18. Reads one
 * team with its newest version, or soft-deletes it (`204`).
 */
import { deleteAgentTeam, getAgentTeam } from '../../../../server/agent-teams/handlers';
import { route } from '../../../../server/http/route';
import { readIdParam, toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function serveGet(request: Request, context: Context): Promise<Response> {
  return toResponse(await getAgentTeam(request, await readIdParam(context)));
}

async function serveDelete(request: Request, context: Context): Promise<Response> {
  return toResponse(await deleteAgentTeam(request, await readIdParam(context)));
}

export const GET = route({ component: 'agent-teams', operation: 'get' }, serveGet);
export const DELETE = route({ component: 'agent-teams', operation: 'remove' }, serveDelete);
