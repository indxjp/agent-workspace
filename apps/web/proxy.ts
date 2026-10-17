/** Next.js request gate for authenticated APIs and the public `/p/**` surface. */
import { CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { NextResponse, type NextRequest } from 'next/server';

import { isAgentEndpointRoute } from './server/auth/agent-endpoint-routes';
import { isApiKeyRoute, matchApiRoute } from './server/auth/api-key-routes';
import { isOAuthRoute } from './server/auth/oauth-routes';
import { checkRequestOrigin } from './server/auth/origin';
import { classifyPath, enforcementFor } from './server/auth/paths';
import { sessionCookieName, readSessionSecret, verifySessionToken } from './server/auth/session';
import { isCliTokenRoutePath } from './server/cli-auth/token-routes';
import {
  preflightSurfaceSession,
  preflightVisitorRun,
  surfacePagePolicy,
  visitorRunResponseHeaders,
} from './server/surfaces/public/handlers';
import {
  negotiateContractsVersion,
  servedContractsHeaders,
} from './server/versioning/contracts-version';

export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};

/**
 * An edge refusal, in the one envelope every `/api/**` failure answers with (`ApiProblemSchema`,
 * issue #238). `reason` — which check failed, e.g. `no_session_cookie` — travels as the single
 * entry of `details`, so an operator can still tell the refusals apart while a client branches on
 * `code` alone.
 */
function deny(status: number, code: string, message: string, reason: string): NextResponse {
  return NextResponse.json(
    { error: { code, message, details: [reason] } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

const UNAUTHENTICATED_MESSAGE = 'Sign in, or present a valid API key, to use this API.';

/**
 * Page-surface paths that must stay reachable with no session: the sign-in screen itself (or
 * redirecting it to itself would loop), and the first-run setup wizard, which by definition runs
 * before any administrator — and therefore any session — exists.
 */
const PAGE_AUTH_EXEMPT_PREFIXES = ['/signin', '/setup'];

function isAuthExemptPage(pathname: string): boolean {
  return PAGE_AUTH_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Issue #236 (SDK-04, S-1): a browser token's credential shape only, scoped by prefix AND by the
 * exact path shapes §3.1's grammar admits — reading a run or its events, and starting a run in a
 * session. Issue #539 (S2-05c) adds a third shape, rating a run (`POST /api/runs/:id/feedback`),
 * whose session row identity the handler checks. This is not the authorisation decision:
 * `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) still refuses a token whose scope
 * does not reach the row a matched path names, and the route still verifies the bearer itself. A
 * too-wide match here would let an unverified bearer past the edge for a shape `decide()` was never
 * asked about; pinned by `proxy.test.ts`.
 */
function isBrowserTokenExemptRoute(request: NextRequest, authorization: string | null): boolean {
  const bearer = authorization === null ? null : /^Bearer[ ]([^ ]+)$/iu.exec(authorization.trim());
  if (!bearer?.[1]?.startsWith('awt_live_')) return false;
  return visitorRouteMethod(request.nextUrl.pathname) === request.method;
}

/**
 * The method of the browser-token path shape `pathname` is, or `null`: the one list both the
 * browser-token exemption above and the visitor run routes' CORS (issue #680) read, so they cannot
 * drift.
 */
function visitorRouteMethod(pathname: string): 'GET' | 'POST' | null {
  if (/^\/api\/runs\/[^/]+(\/events)?$/u.test(pathname)) return 'GET';
  if (
    /^\/api\/agents\/[^/]+\/runs$/u.test(pathname) ||
    /^\/api\/runs\/[^/]+\/feedback$/u.test(pathname)
  ) {
    return 'POST';
  }
  return null;
}

/**
 * Issue #242 (SDK-10, S-22): `aw login`'s three pre-authentication steps — start the device
 * authorization, render the approval page (which answers "sign in first" itself when there is no
 * session), and poll for the token. Exact by method and path; the approval `POST` is not here, so
 * it keeps this gate's session and same-origin checks.
 */
function isCliSignInRoute(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return (
    (request.method === 'POST' &&
      (pathname === '/api/auth/cli-device' || pathname === '/api/auth/cli-token')) ||
    (request.method === 'GET' && pathname === '/api/auth/cli-verify')
  );
}

/**
 * Issue #242 (SDK-10, S-22): the credential shape of the token `aw login` holds, admitted only on
 * the person-facing routes the CLI calls with it — who am I, my workspaces, my workspace's
 * invitations and sharing policy, sign-out and workspace switch. The route verifies the token and
 * re-reads the Membership behind it; a bearer header is never sent by a browser on its own, so
 * these need no origin check.
 */
function isCliTokenRoute(request: NextRequest, authorization: string | null): boolean {
  const bearer = authorization === null ? null : /^Bearer[ ]([^ ]+)$/iu.exec(authorization.trim());
  if (!bearer?.[1]?.startsWith('awu_live_')) return false;
  return isCliTokenRoutePath(request.nextUrl.pathname);
}

/**
 * The runner mirrors durable transcripts with the signed, registered token carried by its one
 * RunRequest. The route adapter verifies it again and binds path/body to its run and session.
 * Issue #242 (SDK-10, S-22) review round 1: never the token `aw login` holds, which ADR-0083
 * admits only on the person-facing routes (`server/cli-auth/token-routes.ts`); the session seam
 * refuses one again.
 */
function isRunnerSessionRoute(request: NextRequest, authorization: string | null): boolean {
  return (
    request.nextUrl.pathname.startsWith('/api/sessions') &&
    authorization !== null &&
    authorization.startsWith('Bearer ') &&
    !authorization.startsWith('Bearer awu_live_')
  );
}

/**
 * What the edge answers a workspace API key (`Bearer ak_live_…`), or `null` for no key or a path
 * the rest of the gate decides.
 *
 * Issue #388: a key is admitted on exactly the catalogue routes whose contracts declare the
 * default credentials (`server/auth/api-key-routes.ts`), not on a hand-kept list that had drifted
 * to five families. The handlers verify the key, including expiry and revocation, and decide its
 * role before any operation.
 *
 * Issue #416: a key on an `/api/**` path no route serves — a typo, or `/api/agents//runs` after an
 * empty id — is answered `404 not_found`, and on a served path under a method it does not take
 * `405 method_not_allowed` with `Allow`, rather than the session gate's `401`, which sent a caller
 * with a valid key looking for a credential problem. The answer is a function of the published
 * catalogue only (`matchApiRoute`), never of the key, so it tells a guessed key nothing the
 * OpenAPI document does not; a request without a key keeps the `401`.
 */
function gateApiKey(request: NextRequest, authorization: string | null): NextResponse | null {
  if (authorization?.startsWith('Bearer ak_live_') !== true) return null;
  const { pathname } = request.nextUrl;
  if (isApiKeyRoute(request.method, pathname)) return NextResponse.next();
  if (!isApiPath(pathname)) return null;
  const match = matchApiRoute(request.method, pathname);
  if (match.kind === 'unknown') {
    return deny(404, 'not_found', 'No API route matches this path.', 'unknown_route');
  }
  if (match.kind === 'method-not-allowed') {
    const response = deny(
      405,
      'method_not_allowed',
      `This path does not accept ${request.method.toUpperCase()}.`,
      'method_not_allowed',
    );
    response.headers.set('allow', match.allow.join(', '));
    return response;
  }
  return null;
}

async function gateRequest(request: NextRequest): Promise<NextResponse> {
  // Setup detection and submission are the only pre-authentication control-plane endpoints.
  if (
    (request.method === 'GET' && request.nextUrl.pathname === '/api/setup/runtime-detect') ||
    (request.method === 'POST' && request.nextUrl.pathname === '/api/setup')
  ) {
    return NextResponse.next();
  }
  // Issue #118's OIDC sign-in exchange. Reaching any of these three is the point of not having a
  // session yet — `/api/auth/login` starts a transaction, `/api/auth/callback` is the identity
  // provider's own `form_post` back to this application, and `/api/auth/workspace` may run with
  // only the short-lived selection cookie `/api/auth/callback` minted, never a tenant session.
  // Each of the three does its own origin check where a state-changing method needs one — see
  // `apps/web/app/api/auth/{callback,workspace}/route.ts` — because exemption from this gate is
  // also exemption from the `checkRequestOrigin` call below.
  if (
    (request.method === 'GET' &&
      (request.nextUrl.pathname === '/api/auth/login' ||
        request.nextUrl.pathname === '/api/auth/workspace')) ||
    (request.method === 'POST' &&
      (request.nextUrl.pathname === '/api/auth/callback' ||
        request.nextUrl.pathname === '/api/auth/workspace'))
  ) {
    return NextResponse.next();
  }
  // Issue #121's one pre-membership operation. This exemption is exact by method and path: the
  // acceptance handler verifies the dedicated invitation-identity cookie and same-origin request
  // itself. No other invitation route can bypass the ordinary tenant-session gate.
  if (
    request.method === 'POST' &&
    /^\/api\/invitations\/[^/]+\/accept$/u.test(request.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }
  const authorization = request.headers.get('authorization');
  if (isRunnerSessionRoute(request, authorization)) {
    return NextResponse.next();
  }
  // ADR-0135: a published agent's A2A endpoint authenticates its own caller (an API key only).
  if (isAgentEndpointRoute(request.method, request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  // ADR-0134 part 3: the OAuth server's token, revoke, authorize and metadata routes.
  if (isOAuthRoute(request.method, request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const apiKeyAnswer = gateApiKey(request, authorization);
  if (apiKeyAnswer !== null) return apiKeyAnswer;
  if (isBrowserTokenExemptRoute(request, authorization)) {
    return NextResponse.next();
  }
  if (isCliSignInRoute(request) || isCliTokenRoute(request, authorization)) {
    return NextResponse.next();
  }
  // ADR-0120 clause 7: Vercel Cron sends no session, only `Authorization: Bearer $CRON_SECRET`, which
  // the route checks itself and which answers 404 where `CRON_SECRET` is unset. Exact by method and path.
  if (request.method === 'GET' && request.nextUrl.pathname === '/api/cron/retention') {
    return NextResponse.next();
  }
  const verdict = classifyPath(request.nextUrl.pathname);
  const enforcement = enforcementFor(verdict.surface);

  // The page surface is never denied (W1-CP-06), but an unauthenticated visit to it is not sent
  // straight through either, now that `/signin` exists: a session is checked here too, and a
  // missing or invalid one redirects to the sign-in screen instead of rendering a shell whose
  // every `/api/**` fetch would then 401 one at a time. `/signin` and `/setup` are exempt because
  // they are exactly the pages a session-less visitor must be able to reach.
  if (
    enforcement === 'allow' &&
    verdict.surface === 'page' &&
    !isAuthExemptPage(request.nextUrl.pathname)
  ) {
    const pageSecret = readSessionSecret(process.env);
    const pageSession = pageSecret.ok
      ? await verifySessionToken(request.cookies.get(sessionCookieName())?.value, pageSecret.secret)
      : { ok: false as const };
    if (!pageSession.ok) {
      // The absolute argument is required here and does NOT reach the client as written, which is
      // why this site is not repaired the way the three in `app/api/auth/callback/route.ts` were
      // (issue #201, and
      // `docs/adr/W9-R9b-relative-location-closes-the-class-and-the-proxy-site-is-owned-by-next.md`).
      //
      // A proxy response is post-processed by Next before it is sent. In `next@16.3.4`,
      // `dist/server/web/adapter.js:394-396` replaces this `Location` with
      // `getRelativeURL(redirectURL, requestURL)` — the URL minus its origin — whenever the two
      // hosts match, and they match *by construction*: the adapter builds `requestURL` from the
      // same `request.url` this line does. So the header on the wire is already `/signin`, with no
      // origin for a client to resolve against the wrong one. That rewrite is itself inside the
      // `!process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard at `:393`, so the relative wire
      // header holds only while that flag is unset — nothing here sets it, and no test covers it.
      //
      // Setting a relative `Location` here instead would not survive: the same adapter passes it to
      // `new NextURL(location, { forceLocale, headers, nextConfig })` at `:384`, whose second
      // argument has no `pathname` key and is therefore read as options, not as a base — so
      // `dist/server/web/next-url.js:16-22` evaluates `new URL('/signin', undefined)` and throws.
      // That is a 500 on every unauthenticated page visit, the most-travelled path in the
      // application, and `:384` sits above the `__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard, so no
      // flag avoids it. Both halves are pinned by tests rather than by this comment — the wire
      // header by `tests/auth.test.ts`'s live `next dev` probe of an unauthenticated `GET /`, and
      // the `NextURL` contract by `apps/web/proxy.test.ts` — so a Next upgrade that changes either
      // fails a check instead of a user's session.
      //
      // Deriving the target from `Host` / `X-Forwarded-Host` is refused for the same reason it is
      // in the callback route: both are caller-supplied, and that trades this defect for an open
      // redirect.
      return NextResponse.redirect(new URL('/signin', request.url));
    }
  }

  if (enforcement === 'allow') return NextResponse.next();

  const secret = readSessionSecret(process.env);
  if (!secret.ok) {
    return deny(401, 'unauthenticated', UNAUTHENTICATED_MESSAGE, 'server_not_configured');
  }
  const result = await verifySessionToken(
    request.cookies.get(sessionCookieName())?.value,
    secret.secret,
  );
  if (!result.ok) return deny(401, 'unauthenticated', UNAUTHENTICATED_MESSAGE, result.code);

  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: request.nextUrl.host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    console.warn(`[auth] cross-origin write refused: ${origin.reason}`);
    return deny(
      403,
      'cross_origin',
      'This write must come from the application origin.',
      'cross_origin',
    );
  }
  return NextResponse.next();
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * ADR-0105 slice 1, S1-17 (#455): the hosted surface page `GET /p/s/<name>` and everything below
 * it — its session bootstrap `POST /p/s/<name>/sessions` included — may be framed by this origin
 * only, except the page itself, which a surface's `allowedOrigins` may also frame (issue #622).
 * Matched case-sensitively, as `server/auth/paths.ts` classifies `/p`: `/P/s/x` is not a surface
 * path. A `/p/:token` share is not under `/p/s` and keeps its own headers.
 */
function isSurfacePath(pathname: string): boolean {
  return pathname === '/p/s' || pathname.startsWith('/p/s/');
}

const SURFACE_FRAME_ANCESTORS = "frame-ancestors 'self'";

/** The `<name>` of a `/p/s/<name>` path followed by exactly `suffix`, or `null`. */
function surfaceNameOf(pathname: string, suffix: '' | '/sessions'): string | null {
  const match = /^\/p\/s\/([^/]+)(\/sessions)?$/u.exec(pathname);
  if (match?.[1] === undefined || (match[2] ?? '') !== suffix) return null;
  return match[1];
}

/**
 * Issue #622: the CORS preflight of a surface's session bootstrap. With the run routes a visitor
 * token may call ({@link proxy}, issue #680) it is the control plane's only cross-origin surface.
 * Answered here, before any route, so no route file exports `OPTIONS`.
 */
async function surfacePreflight(request: NextRequest): Promise<NextResponse | null> {
  if (request.method !== 'OPTIONS') return null;
  const name = surfaceNameOf(request.nextUrl.pathname, '/sessions');
  if (name === null) return null;
  const headers = await preflightSurfaceSession(name, request.headers);
  return new NextResponse(null, {
    status: 204,
    headers: { ...headers, 'content-security-policy': SURFACE_FRAME_ANCESTORS },
  });
}

/** The CSP of a `/p/s/**` answer: the page's from its surface (#622), `'self'` for the rest. */
async function surfacePolicy(request: NextRequest): Promise<string> {
  const name = request.method === 'GET' ? surfaceNameOf(request.nextUrl.pathname, '') : null;
  return name === null ? SURFACE_FRAME_ANCESTORS : surfacePagePolicy(name);
}

function withServedContracts(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(servedContractsHeaders())) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * Issue #244 (SDK-12, S-7): contracts version negotiation runs first on every `/api/**` request —
 * before the exemptions below, authentication, authorisation or any body is read — so a client
 * the control plane no longer serves gets `426 contracts_version_unsupported` and nothing else.
 * A request without the header (a browser form, link or IdP callback) is served at the current
 * version. Every `/api/**` answer that passes through here carries the served range.
 *
 * Issue #680: the run routes a visitor token may call ({@link visitorRouteMethod}) answer CORS to
 * an origin a served surface allows — their preflight first, here, and every answer after,
 * refusals included — and no other `/api/**` path does.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!isApiPath(request.nextUrl.pathname)) {
    const preflight = await surfacePreflight(request);
    if (preflight !== null) return preflight;
    const response = await gateRequest(request);
    if (isSurfacePath(request.nextUrl.pathname)) {
      response.headers.set('content-security-policy', await surfacePolicy(request));
    }
    return response;
  }
  const visitorMethod = visitorRouteMethod(request.nextUrl.pathname);
  if (visitorMethod !== null && request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: await preflightVisitorRun(visitorMethod, request.headers),
    });
  }
  const negotiation = negotiateContractsVersion(request.headers.get(CONTRACTS_VERSION_HEADER));
  const response =
    negotiation.kind === 'refused'
      ? NextResponse.json(negotiation.body, {
          status: negotiation.status,
          headers: { 'cache-control': 'no-store', ...negotiation.headers },
        })
      : await gateRequest(request);
  if (visitorMethod !== null) {
    for (const [name, value] of Object.entries(await visitorRunResponseHeaders(request.headers))) {
      response.headers.set(name, value);
    }
  }
  return withServedContracts(response);
}
