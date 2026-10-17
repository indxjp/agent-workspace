import { readPointerBody, serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import { setAgentPointer } from '../../../../../server/agent-versions/pointers';

/**
 * `PUT /api/agents/:id/pointers` (S1-06, issue #444; ADR-0101): point an environment at a saved
 * version. Authorisation, the runtimes and the body bound live in
 * `server/agent-versions/http.ts`; the move itself in `server/agent-versions/pointers.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(
    request,
    context,
    async ({ agent, principal, store, ceiling, toolBundles, toolHost, toolDomainsRefusal }) => {
      const body = await readPointerBody(request);
      if (!body.ok) return body.result;
      return setAgentPointer(body.value, agent, principal, {
        store,
        ceiling,
        toolBundles,
        toolHost,
        toolDomainsRefusal,
      });
    },
  );
}
