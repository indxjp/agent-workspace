/**
 * `POST /api/auth/email-link/verify` — consume a sign-in link and sign the guest in to their demo
 * workspace (spec §21, "Guest"). Pre-session: the handler does its own same-origin check and rate
 * limits. See `server/email-link/transport/routes.ts`.
 */
import { applicationContext } from '../../../../../server/application-context';
import { sessionSecret } from '../../../../../server/auth';
import { route } from '../../../../../server/http/route';
import { verifyEmailLink } from '../../../../../server/email-link/transport/routes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function verify(request: Request): Promise<Response> {
  const secret = sessionSecret();
  return verifyEmailLink(
    request,
    applicationContext()?.emailLink ?? null,
    secret.ok ? secret.secret : null,
    applicationContext()?.store.baseUrl ?? null,
  );
}

export const POST = route({ component: 'auth', operation: 'email-link-verify' }, verify);
