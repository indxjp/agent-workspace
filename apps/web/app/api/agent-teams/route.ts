/**
 * `GET`/`POST /api/agent-teams` — ADR-0104 acceptance, issue #1516, spec 04 §5.18. A thin adapter
 * over `apps/web/server/agent-teams/handlers.ts`, which is tested without a server.
 */
import { createAgentTeam, listAgentTeams } from '../../../server/agent-teams/handlers';
import { route } from '../../../server/http/route';
import { toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serveList(request: Request): Promise<Response> {
  return toResponse(await listAgentTeams(request));
}

async function serveCreate(request: Request): Promise<Response> {
  return toResponse(await createAgentTeam(request));
}

export const GET = route({ component: 'agent-teams', operation: 'list' }, serveList);
export const POST = route({ component: 'agent-teams', operation: 'create' }, serveCreate);
