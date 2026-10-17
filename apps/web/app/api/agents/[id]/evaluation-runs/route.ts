import { serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import {
  getEvaluationRun,
  readEvaluationRunBody,
  startEvaluationRun,
} from '../../../../../server/evaluations/runs';
import { getRunApi } from '../../../../../server/runs/environment';

/**
 * `POST /api/agents/:id/evaluation-runs` (issue #799): store an evaluation of up to 200 cases that
 * the client then advances. `GET` reads a run (`?evaluation=<id>`) at any status. Authorisation
 * lives in `server/agent-versions/http.ts`; the run in `server/evaluations/runs.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, async ({ agent, principal, store }) => {
    const body = await readEvaluationRunBody(request);
    if (!body.ok) return body.result;
    return startEvaluationRun(body.value, agent.id, principal, { store, runs: getRunApi() });
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, ({ agent, principal }) =>
    getEvaluationRun(agent.id, new URL(request.url).searchParams.get('evaluation'), principal, {
      runs: getRunApi(),
    }),
  );
}
