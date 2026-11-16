/**
 * `PUT /api/demo/verification/{workspaceId}` — copy every demo template into the real-model
 * verification workspace, as a visitor's demo copy is made. Called by the operator with
 * `Authorization: Bearer <AW_DEMO_OPERATOR_TOKEN>` (route registry exclusion); `404` while the token
 * is unset. The logic is `server/demo/provision/routes.ts`.
 */
import { applicationContext } from '../../../../../server/application-context';
import { systemClock } from '../../../../../server/clock';
import { putDemoVerification } from '../../../../../server/demo/provision/routes';
import { NO_DEMO_OPERATOR } from '../../../../../server/demo/operator';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route(
  { component: 'demo', operation: 'verification.fill' },
  async (request: Request, context: { params: Promise<{ workspaceId: string }> }) =>
    putDemoVerification(
      request,
      (await context.params).workspaceId,
      applicationContext()?.demoOperator ?? NO_DEMO_OPERATOR,
      systemClock.now(),
    ),
);
