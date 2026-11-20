/** Next.js request gate for authenticated APIs and the public `/p/**` surface. */
import { CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { FEATURE_PROBLEM_CODES, type FeatureProblemCode } from '@indx-workspace/contracts/features';
import { NextResponse, type NextRequest } from 'next/server';

import {
  isSurfacePath,
  setHeaders,
  storeCors,
  storeFacts,
  storePreflight,
  surfacePolicy,
  surfacePreflight,
  visitorPreflight,
} from './proxy-cors';
import {
  isApiPath,
  isAuthExemptPage,
  passesAfterApiKeyGate,
  passesBeforeApiKeyGate,
  visitorRouteMethod,
} from './proxy-routes';
import { verifyRequestSession } from './proxy-session';
import { isApiKeyRoute, matchApiRoute } from './server/auth/api-key-routes';
import { checkRequestOrigin } from './server/auth/origin';
import { classifyPath, enforcementFor } from './server/auth/paths';
import { storeOriginFor } from './server/auth/store-origin';
import { readDeploymentFeatures } from './server/features/deployment';
import { routeFeatureOf } from './server/features/route-feature';
import { visitorRunResponseHeaders } from './server/surfaces/public/handlers';
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

// The page surface is never denied (W1-CP-06), but an unauthenticated visit to it is not sent
// straight through either, now that `/signin` exists: a session is checked here too, and a
// missing or invalid one redirects to the sign-in screen instead of rendering a shell whose
// every `/api/**` fetch would then 401 one at a time. `/signin` and `/setup` are exempt because
// they are exactly the pages a session-less visitor must be able to reach.
async function signInRedirect(request: NextRequest): Promise<NextResponse | null> {
  if (isAuthExemptPage(request.nextUrl.pathname)) return null;
  const pageSession = await verifyRequestSession(request);
  if (pageSession.ok) return null;
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

const FEATURE_DISABLED = 'feature_disabled' satisfies FeatureProblemCode;

/**
 * ADR-0160 D7: a route whose feature this deployment does not install answers `404 feature_disabled`
 * before any credential is checked, because it reveals nothing beyond what the deployment serves.
 * The public `/p/**` pages are left to their own not-found, so a visitor learns nothing from them.
 */
function gateFeature(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/p/')) return null;
  const feature = routeFeatureOf(request.method, pathname);
  if (feature === null || feature === 'core') return null;
  let installed: readonly string[];
  try {
    installed = readDeploymentFeatures(process.env);
  } catch {
    return deny(
      503,
      'service_unavailable',
      'This deployment is misconfigured.',
      'deployment_features_invalid',
    );
  }
  if (installed.includes(feature)) return null;
  return deny(
    FEATURE_PROBLEM_CODES[FEATURE_DISABLED],
    FEATURE_DISABLED,
    `${feature} is not installed in this deployment.`,
    feature,
  );
}

/** Refuse a request whose session does not verify, or whose write comes from another origin. */
async function gateSession(request: NextRequest): Promise<NextResponse | null> {
  const result = await verifyRequestSession(request);
  if (!result.ok) {
    const reason = result.code;
    return deny(401, 'unauthenticated', UNAUTHENTICATED_MESSAGE, reason);
  }
  const store = storeOriginFor(storeFacts(request, result.claims.via ?? null));
  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: request.nextUrl.host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
    ...(store === null ? {} : { allowedOrigins: [store] }),
  });
  if (origin.ok) return null;
  console.warn(`[auth] cross-origin write refused: ${origin.reason}`);
  return deny(
    403,
    'cross_origin',
    'This write must come from the application origin.',
    'cross_origin',
  );
}

/** The answer of a page-surface request that needs no further check, or `null` to continue. */
async function gatePageOrAllowed(request: NextRequest): Promise<NextResponse | null> {
  const verdict = classifyPath(request.nextUrl.pathname);
  const enforcement = enforcementFor(verdict.surface);
  if (enforcement !== 'allow') return null;
  if (verdict.surface === 'page') {
    const redirect = await signInRedirect(request);
    if (redirect !== null) return redirect;
  }
  return NextResponse.next();
}

async function gateRequest(request: NextRequest): Promise<NextResponse> {
  const featureAnswer = gateFeature(request);
  if (featureAnswer !== null) return featureAnswer;
  const authorization = request.headers.get('authorization');
  if (passesBeforeApiKeyGate(request, authorization)) return NextResponse.next();
  const apiKeyAnswer = gateApiKey(request, authorization);
  if (apiKeyAnswer !== null) return apiKeyAnswer;
  if (passesAfterApiKeyGate(request, authorization)) return NextResponse.next();
  const allowed = await gatePageOrAllowed(request);
  if (allowed !== null) return allowed;
  return (await gateSession(request)) ?? NextResponse.next();
}

/** The `426` a client the control plane no longer serves gets, or `null`. */
function contractsVersionRefusal(request: NextRequest): NextResponse | null {
  const negotiation = negotiateContractsVersion(request.headers.get(CONTRACTS_VERSION_HEADER));
  if (negotiation.kind !== 'refused') return null;
  return NextResponse.json(negotiation.body, {
    status: negotiation.status,
    headers: { 'cache-control': 'no-store', ...negotiation.headers },
  });
}

/** A page request: surface preflight first, then the gate, with the surface's framing policy. */
async function proxyPage(request: NextRequest): Promise<NextResponse> {
  const preflight = await surfacePreflight(request);
  if (preflight !== null) return preflight;
  const response = await gateRequest(request);
  if (isSurfacePath(request.nextUrl.pathname)) {
    response.headers.set('content-security-policy', await surfacePolicy(request));
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
  if (!isApiPath(request.nextUrl.pathname)) return proxyPage(request);
  const visitorMethod = visitorRouteMethod(request.nextUrl.pathname);
  const preflight = storePreflight(request) ?? (await visitorPreflight(request, visitorMethod));
  if (preflight !== null) return preflight;
  const response = contractsVersionRefusal(request) ?? (await gateRequest(request));
  if (visitorMethod !== null) {
    setHeaders(response, await visitorRunResponseHeaders(request.headers));
  }
  const storeHeaders = await storeCors(request);
  if (storeHeaders !== null) setHeaders(response, storeHeaders);
  setHeaders(response, servedContractsHeaders());
  return response;
}
