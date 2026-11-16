/**
 * `PUT /api/demo/maintenance/{entry}` — the daily production test's verdict on one live Agent Store
 * entry, from the deployment's operator (bearer `AW_DEMO_OPERATOR_TOKEN`). See
 * `server/demo/maintenance/routes.ts`.
 */
import { applicationContext } from '../../../../../server/application-context';
import { systemClock } from '../../../../../server/clock';
import { putDemoMaintenance } from '../../../../../server/demo/maintenance/routes';
import { NO_DEMO_OPERATOR } from '../../../../../server/demo/operator';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function put(request: Request, context: { params: Promise<{ entry: string }> }): Promise<Response> {
  return context.params.then(({ entry }) =>
    putDemoMaintenance(request, entry, applicationContext()?.demoOperator ?? NO_DEMO_OPERATOR, () =>
      systemClock.now(),
    ),
  );
}

export const PUT = route({ component: 'demo', operation: 'maintenance' }, put);
