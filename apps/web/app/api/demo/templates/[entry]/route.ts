/**
 * `PUT /api/demo/templates/{entry}` — fill one entry's demo template from a seed (the agent's K-1
 * definition, its connectors' read and write tools, its sample files and records). Called by the
 * deploy's seeding step with `Authorization: Bearer <AW_DEMO_OPERATOR_TOKEN>` (route registry
 * exclusion); `404` while the token is unset. The logic is `server/demo/provision/routes.ts`.
 */
import { applicationContext } from '../../../../../server/application-context';
import { systemClock } from '../../../../../server/clock';
import { putDemoTemplate } from '../../../../../server/demo/provision/routes';
import { NO_DEMO_OPERATOR } from '../../../../../server/demo/operator';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route(
  { component: 'demo', operation: 'templates.seed' },
  async (request: Request, context: { params: Promise<{ entry: string }> }) =>
    putDemoTemplate(
      request,
      (await context.params).entry,
      applicationContext()?.demoOperator ?? NO_DEMO_OPERATOR,
      systemClock.now(),
    ),
);
