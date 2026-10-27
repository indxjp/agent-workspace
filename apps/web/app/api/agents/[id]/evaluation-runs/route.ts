import { serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import {
  getEvaluationRun,
  readEvaluationRunBody,
  startEvaluationRun,
} from '../../../../../server/evaluations/runs';
import { getRunApi } from '../../../../../server/runs/environment';
import { route } from '../../../../../server/http/route';

/**
 * `POST /api/agents/:id/evaluation-runs` (issue #799): store an evaluation of up to 200 cases that
 * the client then advances. `GET` reads a run (`?evaluation=<id>`) at any status. Authorisation
 * lives in `server/agent-versions/http.ts`; the run in `server/evaluations/runs.ts`.
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
    'start-evaluation-run',
    async ({ agent, principal, store }) => {
      const body = await readEvaluationRunBody(request);
      if (!body.ok) return body.result;
      return startEvaluationRun(body.value, agent.id, principal, { store, runs: getRunApi() });
    },
  );
}

export const POST = route({ component: 'evaluations', operation: 'start-run' }, servePost);

async function serveGet(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, 'read', ({ agent, principal }) =>
    getEvaluationRun(agent.id, new URL(request.url).searchParams.get('evaluation'), principal, {
      runs: getRunApi(),
    }),
  );
}

export const GET = route({ component: 'evaluations', operation: 'get-run' }, serveGet);
