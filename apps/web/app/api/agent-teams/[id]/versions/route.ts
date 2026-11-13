/**
 * `POST`/`GET /api/agent-teams/:id/versions` — ADR-0104 acceptance decision 11, issue #1516, spec
 * 04 §5.18. Saves a team's next immutable version (`201`), or lists them newest first.
 */
import {
  createAgentTeamVersion,
  listAgentTeamVersions,
} from '../../../../../server/agent-teams/handlers';
import { route } from '../../../../../server/http/route';
import { readIdParam, toResponse } from '../../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function serveCreate(request: Request, context: Context): Promise<Response> {
  return toResponse(await createAgentTeamVersion(request, await readIdParam(context)));
}

async function serveList(request: Request, context: Context): Promise<Response> {
  return toResponse(await listAgentTeamVersions(request, await readIdParam(context)));
}

export const POST = route({ component: 'agent-teams', operation: 'versions.create' }, serveCreate);
export const GET = route({ component: 'agent-teams', operation: 'versions.list' }, serveList);
