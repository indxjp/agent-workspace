import {
  createAgentVersion,
  listAgentVersions,
} from '../../../../../server/agent-versions/handlers';
import {
  readAgentVersionBody,
  serveAgentVersionRoute,
} from '../../../../../server/agent-versions/http';

/**
 * `GET`/`POST /api/agents/:id/versions` (S1-05, issue #443; ADR-0101). Authorisation, the
 * runtimes and the body bound live in `server/agent-versions/http.ts`; the version pipeline every
 * save and dry run share (C8) in `server/agent-versions/pipeline.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, ({ agent, store }) =>
    listAgentVersions(agent.id, store),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(
    request,
    context,
    async ({ agent, principal, store, ceiling, toolBundles, toolHost, toolDomainsRefusal }) => {
      const body = await readAgentVersionBody(request);
      if (!body.ok) return body.result;
      return createAgentVersion(body.value, agent, principal.principalId, {
        store,
        ceiling,
        toolBundles,
        toolHost,
        toolDomainsRefusal,
      });
    },
  );
}
