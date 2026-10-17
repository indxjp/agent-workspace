import { serveAgentVersionRoute } from '../../../../../server/agent-versions/http';
import {
  advanceEvaluationRun,
  readEvaluationRunBody,
} from '../../../../../server/evaluations/runs';
import { getRunApi } from '../../../../../server/runs/environment';

/**
 * `POST /api/agents/:id/evaluation-advance` (issue #799): run the next cases of an evaluation run
 * and answer its progress. It stops starting cases after about 120 s, so the client calls it again
 * until the run's `status` is `completed`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, async ({ agent, principal }) => {
    const body = await readEvaluationRunBody(request);
    if (!body.ok) return body.result;
    return advanceEvaluationRun(body.value, agent.id, principal, { runs: getRunApi() });
  });
}
