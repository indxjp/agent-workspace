/**
 * `GET /api/store/privacy` — the facts the store's privacy notice states that only this
 * deployment's configuration knows. Public: no session. See
 * `server/demo/storefront/transport/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { getStorePrivacy } from '../../../../server/demo/storefront/transport/routes';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function read(): Promise<Response> {
  return Promise.resolve(getStorePrivacy(applicationContext()?.store ?? null));
}

export const GET = route({ component: 'store', operation: 'privacy' }, read);
