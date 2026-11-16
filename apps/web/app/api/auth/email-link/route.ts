/**
 * `POST /api/auth/email-link` — send a sign-in link to an address (spec §21, "Guest"). Pre-session:
 * the handler does its own same-origin check and rate limits. See
 * `server/email-link/transport/routes.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { route } from '../../../../server/http/route';
import { issueEmailLink } from '../../../../server/email-link/transport/routes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function issue(request: Request): Promise<Response> {
  return issueEmailLink(
    request,
    applicationContext()?.emailLink ?? null,
    applicationContext()?.store.baseUrl ?? null,
  );
}

export const POST = route({ component: 'auth', operation: 'email-link' }, issue);
