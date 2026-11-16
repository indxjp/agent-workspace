/**
 * `GET /api/demo/templates` — every demo template the deployment made, and what a visitor's copy of
 * it would get, for the nightly sample check. Called with `Authorization: Bearer
 * <AW_DEMO_OPERATOR_TOKEN>` (route registry exclusion); `404` while the token is unset. The logic is
 * `server/demo/provision/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { getDemoTemplates } from '../../../../server/demo/provision/routes';
import { NO_DEMO_OPERATOR } from '../../../../server/demo/operator';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route({ component: 'demo', operation: 'templates.report' }, (request: Request) =>
  getDemoTemplates(request, applicationContext()?.demoOperator ?? NO_DEMO_OPERATOR),
);
