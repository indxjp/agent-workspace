import { readPointerBody, serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import { promoteAgent } from '../../../../../server/agent-versions/pointers';
import { route } from '../../../../../server/http/route';

/**
 * `POST /api/agents/:id/promote` (issue #615): point `production` at `local`'s version, or check the
 * move with `dryRun`. Authorisation, the runtimes and the body bound live in
 * `server/agent-versions/http.ts`; the decision and the move in `server/agent-versions/pointers.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(
    request,
    context,
    'promote',
    async ({
      agent,
      principal,
      store,
      ceiling,
      toolBundles,
      storageConnections,
      toolHost,
      toolDomainsRefusal,
    }) => {
      const body = await readPointerBody(request);
      if (!body.ok) return body.result;
      return promoteAgent(body.value, agent, principal, {
        store,
        ceiling,
        toolBundles,
        storageConnections,
        toolHost,
        toolDomainsRefusal,
      });
    },
  );
}

export const POST = route({ component: 'agent-versions', operation: 'promote' }, servePost);
