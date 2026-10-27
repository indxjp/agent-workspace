/**
 * `POST /api/auth/callback` — the OIDC `form_post` callback, moved out of
 * `apps/web/app/p/[token]/messages/route.ts` (issue #118; that file keeps only public-share
 * behaviour now).
 *
 * Order of checks matters and is the order below: origin, then the transaction cookie, then
 * `finishOidcLogin` (state + PKCE, already `oidc.ts`'s job and unchanged here). Nothing before a
 * successful `finishOidcLogin` reads or writes anything about an identity, and nothing on any
 * refused path sets a session or selection cookie — only `apps/web/server/auth/oidc.ts`'s own
 * transaction cookie is ever cleared, because it was consumed either way.
 *
 * Once an identity is resolved, this never trusts the session it is about to mint on its own say:
 *
 *   * zero CURRENT memberships → a short-lived invitation-identity cookie, not a tenant session
 *     and not a durable user or identity binding;
 *   * exactly one → minted immediately, because there is nothing to choose;
 *   * more than one → no session yet. A short-lived, signed, selection cookie
 *     (`apps/web/server/auth/selection.ts`) is set instead and the browser is sent to the minimal
 *     selection step at `GET /api/auth/workspace`; `POST` on the same route re-reads membership
 *     before minting anything.
 *
 * `finishOidcLogin` is threaded through `deps` rather than called directly. Every other branch
 * here is exercised in `callback.test.ts` against the real modules this file imports; that one
 * network call is the one this task's declared gap G-4 already names ("no live identity-provider
 * verification; tests use a stubbed issuer fixture") — a fake `finishOidcLogin` stands in for it,
 * so what is actually proved is that this handler reacts correctly to what the real function
 * returns or throws, not that the real function's HTTP exchange with a provider is correct (that
 * claim belongs to `apps/web/server/auth/oidc.ts`, which this task did not change).
 */
import { log } from '../../../../server/telemetry/logger';
import { NextResponse } from 'next/server';

import {
  oidcTransactionCookieName,
  checkRequestOrigin,
  clearedInvitationIdentityCookie,
  finishOidcLogin as finishOidcLoginReal,
  invitationIdentityCookie,
  mintInvitationIdentityToken,
  mintSelectionToken,
  mintSessionToken,
  newSessionClaims,
  readOidcConfiguration,
  readSessionSecret,
  safeNextPath,
  selectionCookie,
  sessionCookie,
} from '../../../../server/auth';
import { cookieValue } from '../../../../server/auth/cookies';
import { resolveOidcSignIn } from '../../../../server/auth/login';
import { applicationContext } from '../../../../server/application-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every redirect this route issues is to a path on the origin the caller already reached, so the
 * `Location` is that path and nothing else. A relative reference is valid per RFC 9110 §10.2.2 and
 * every browser resolves it against the request URL, which is the only origin that can be right.
 *
 * An absolute URL cannot be: `NextResponse.redirect` needs one, and the only origin available to
 * build it from is `request.url` — the address this server is *bound to*, not the address the
 * client used. They differ whenever a reverse proxy, a container port map or a host alias sits in
 * between, and the redirect then crosses origins: the session, selection or invitation-identity
 * cookie set below is minted for the caller's host and is not sent to the server's, so a sign-in
 * that succeeded arrives signed out. The `Host` and `X-Forwarded-Host` headers would name the
 * caller's origin, but they are caller-supplied, and an open redirect is a worse defect than the
 * one it fixes. A relative `Location` needs no origin at all.
 *
 * Same shape, same reasoning as `apps/web/app/api/auth/workspace/route.ts` — six duplicated lines
 * rather than a shared module, because the doc comment is the point and it belongs in the file a
 * reader of these redirects has open.
 */
function redirectTo(pathname: string, query = ''): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: `${pathname}${query}` } });
}

/** Matches the conditional this cookie was minted with in `/api/auth/login`. */
function transactionCookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function clearTransactionCookie(request: Request) {
  return {
    name: oidcTransactionCookieName(),
    value: '',
    httpOnly: true as const,
    secure: transactionCookieSecure(request),
    sameSite: 'lax' as const,
    path: '/' as const,
    maxAge: 0,
  };
}

export interface CallbackDeps {
  readonly finishOidcLogin: typeof finishOidcLoginReal;
}

const defaultDeps: CallbackDeps = { finishOidcLogin: finishOidcLoginReal };

export async function handleCallback(
  request: Request,
  deps: CallbackDeps = defaultDeps,
): Promise<Response> {
  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: new URL(request.url).host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    log.warn(`[auth] cross-origin OIDC callback refused`, { reason: origin.reason });
    return NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  }

  const configuration = readOidcConfiguration();
  const secret = readSessionSecret(process.env);
  if (configuration === null || !secret.ok) {
    return NextResponse.json({ error: 'oidc_not_configured' }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'malformed_request' }, { status: 400 });
  }

  const cookieHeader = request.headers.get('cookie');
  const transaction = cookieValue(cookieHeader, oidcTransactionCookieName());
  if (transaction === undefined) {
    return NextResponse.json({ error: 'oidc_transaction_missing' }, { status: 400 });
  }

  let identity: Awaited<ReturnType<typeof finishOidcLoginReal>>;
  try {
    const callbackUrl = new URL(configuration.redirectUri);
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') callbackUrl.searchParams.set(name, value);
    }
    identity = await deps.finishOidcLogin(
      configuration,
      secret.secret,
      callbackUrl,
      decodeURIComponent(transaction),
    );
  } catch (error) {
    log.error('[auth] OIDC callback rejected', { error });
    const response = NextResponse.json({ error: 'oidc_callback_rejected' }, { status: 401 });
    response.cookies.set(clearTransactionCookie(request));
    return response;
  }

  const runtime = applicationContext()?.rbac ?? null;
  if (runtime === null) {
    return NextResponse.json({ error: 'rbac_runtime_not_configured' }, { status: 503 });
  }

  const result = await resolveOidcSignIn(runtime.directory, configuration.issuer, identity);

  switch (result.kind) {
    case 'invitation': {
      const invitationIdentity = await mintInvitationIdentityToken(
        { email: identity.email, issuer: configuration.issuer, subject: identity.subject },
        secret.secret,
      );
      const response = redirectTo('/signin', '?invitation=ready');
      response.cookies.set(invitationIdentityCookie(invitationIdentity));
      response.cookies.set(clearTransactionCookie(request));
      return response;
    }
    case 'session': {
      const token = await mintSessionToken(
        newSessionClaims(result.email, result.workspaceSlug),
        secret.secret,
      );
      // Re-validated although the transaction is signed: the guard is the only thing standing
      // between a `next` value and an open redirect.
      const response = redirectTo(safeNextPath(identity.next) ?? '/');
      response.cookies.set(sessionCookie(token));
      response.cookies.set(clearedInvitationIdentityCookie());
      response.cookies.set(clearTransactionCookie(request));
      return response;
    }
    case 'select': {
      const selection = await mintSelectionToken(result.userId, result.email, secret.secret);
      // Carried to the picker, which validates it again on every read.
      const next = safeNextPath(identity.next);
      const response = redirectTo(
        '/api/auth/workspace',
        next === null ? '' : `?${new URLSearchParams({ next }).toString()}`,
      );
      response.cookies.set(selectionCookie(selection));
      response.cookies.set(clearedInvitationIdentityCookie());
      response.cookies.set(clearTransactionCookie(request));
      return response;
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCallback(request);
}
