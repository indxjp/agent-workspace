import { serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import {
  evaluateAgentVersion,
  readEvaluationBody,
} from '../../../../../server/evaluations/handlers';
import { getRunApi } from '../../../../../server/runs/environment';
import { route } from '../../../../../server/http/route';

/**
 * `POST /api/agents/:id/evaluations` (issue #618): run a version's evaluation cases on the server
 * and store the score. Authorisation lives in `server/agent-versions/http.ts`; the evaluation in
 * `server/evaluations/handlers.ts`.
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
    'evaluate',
    async ({ agent, principal, store }) => {
      const body = await readEvaluationBody(request);
      if (!body.ok) return body.result;
      return evaluateAgentVersion(body.value, agent.id, principal, { store, runs: getRunApi() });
    },
  );
}

export const POST = route({ component: 'evaluations', operation: 'evaluate' }, servePost);
