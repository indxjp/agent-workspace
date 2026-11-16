/**
 * `GET /api/store/demos` — which live Agent Store entries are under maintenance, for the store's
 * cards and Try tabs. Public: no session. See `server/demo/maintenance/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { getStoreDemos } from '../../../../server/demo/maintenance/routes';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function read(): Promise<Response> {
  return getStoreDemos(applicationContext()?.demoOperator ?? null);
}

export const GET = route({ component: 'store', operation: 'demos' }, read);
