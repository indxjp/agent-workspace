/**
 * `GET /api/demo/readiness` — the deploy's read-only check that the demo's Anthropic API key is
 * configured and the Anthropic API answers with it, from the deployment's operator (bearer
 * `AW_DEMO_OPERATOR_TOKEN`). See `server/demo/maintenance/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { getDemoReadiness } from '../../../../server/demo/maintenance/routes';
import { NO_DEMO_OPERATOR } from '../../../../server/demo/operator';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function read(request: Request): Promise<Response> {
  return getDemoReadiness(request, applicationContext()?.demoOperator ?? NO_DEMO_OPERATOR);
}

export const GET = route({ component: 'demo', operation: 'readiness' }, read);
