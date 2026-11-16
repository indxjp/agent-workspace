/**
 * `POST /api/store/leads` — the Agent Store's enquiry and launch-notice form. Pre-session: the
 * handler does its own same-origin check, challenge and per-client limit. See
 * `server/demo/storefront/transport/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { postStoreLead } from '../../../../server/demo/storefront/transport/routes';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function receive(request: Request): Promise<Response> {
  return postStoreLead(request, applicationContext()?.store ?? null);
}

export const POST = route({ component: 'store', operation: 'lead' }, receive);
