/** The sign-in session of a request, as the edge gate reads it. */
import type { NextRequest } from 'next/server';

import {
  readSessionSecret,
  signInSessionCookieName,
  verifySignInSessionToken,
  type VerifyResult,
} from './server/auth/session';

/**
 * Verify the request's sign-in cookie. Read live here; the routes read the copy `register()`
 * installed at start-up. They agree in production. Under `next dev` a `.env` edit reaches only this
 * read, so a change to SESSION_SECRET or AW_INSTANCE_ID needs a dev-server restart
 * (CONTRIBUTING.md, "Development setup"). A deployment with no usable secret answers
 * `server_not_configured`.
 */
export async function verifyRequestSession(request: NextRequest): Promise<VerifyResult> {
  const secret = readSessionSecret(process.env);
  if (!secret.ok) return { ok: false, code: 'server_not_configured', reason: secret.reason };
  return verifySignInSessionToken(
    request.cookies.get(signInSessionCookieName(process.env))?.value,
    secret.secret,
  );
}
