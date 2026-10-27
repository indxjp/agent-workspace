/**
 * `GET /api/auth/login` — begin the OIDC authorization-code flow, moved out of
 * `apps/web/app/p/[token]/messages/route.ts` (issue #118).
 *
 * A safe method: it changes nothing about any identity, only starts a transaction and redirects.
 * `checkRequestOrigin` therefore has nothing to check here — `GET` is in `SAFE_METHODS` and the
 * function returns `ok` for every safe method without reading the header at all.
 *
 * `beginOidcLogin` discovers the identity provider over the network, and an unreachable or
 * misconfigured provider is not this deployment's composition root failing to wire anything — the
 * 503 `oidc_not_configured` above already answers that question. It is the *provider* failing to
 * answer, which is a 502.
 */
import { log } from '../../../../server/telemetry/logger';
import { NextResponse } from 'next/server';

import {
  beginOidcLogin,
  oidcTransactionCookieName,
  readOidcConfiguration,
  readSessionSecret,
  safeNextPath,
} from '../../../../server/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const configuration = readOidcConfiguration();
  const secret = readSessionSecret(process.env);
  if (configuration === null || !secret.ok) {
    return NextResponse.json({ error: 'oidc_not_configured' }, { status: 503 });
  }
  const url = new URL(request.url);
  let login: Awaited<ReturnType<typeof beginOidcLogin>>;
  try {
    login = await beginOidcLogin(
      configuration,
      secret.secret,
      Date.now(),
      safeNextPath(url.searchParams.get('next')),
    );
  } catch (error) {
    log.error('[auth] OIDC discovery failed', { error });
    return NextResponse.json({ error: 'oidc_provider_unreachable' }, { status: 502 });
  }
  const response = NextResponse.redirect(login.url, 303);
  response.cookies.set({
    name: oidcTransactionCookieName(),
    value: login.transaction,
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return response;
}
