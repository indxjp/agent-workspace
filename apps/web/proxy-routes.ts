/** Which requests the edge gate lets by without a session, each exact by method and path. */
import type { NextRequest } from 'next/server';

import { isAgentEndpointRoute } from './server/auth/agent-endpoint-routes';
import { isAppBackendRoute } from './server/auth/app-backend-routes';
import { isOAuthRoute } from './server/auth/oauth-routes';
import { isCliTokenRoutePath } from './server/cli-auth/token-routes';

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Page-surface paths that must stay reachable with no session: the sign-in screen itself (or
 * redirecting it to itself would loop), and the first-run setup wizard, which by definition runs
 * before any administrator — and therefore any session — exists.
 */
const PAGE_AUTH_EXEMPT_PREFIXES = ['/signin', '/setup'];

export function isAuthExemptPage(pathname: string): boolean {
  return PAGE_AUTH_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The method of the browser-token path shape `pathname` is, or `null`: the one list both the
 * browser-token exemption below and the visitor run routes' CORS (issue #680) read, so they cannot
 * drift.
 */
export function visitorRouteMethod(pathname: string): 'GET' | 'POST' | null {
  if (/^\/api\/runs\/[^/]+(\/events)?$/u.test(pathname)) return 'GET';
  if (
    /^\/api\/agents\/[^/]+\/runs$/u.test(pathname) ||
    /^\/api\/runs\/[^/]+\/feedback$/u.test(pathname) ||
    // Issue #251 (SDK-19, N-4): a session token mints presigned URLs for its own session's files.
    /^\/api\/files\/[^/]+\/(upload|download)-urls$/u.test(pathname) ||
    // Issue #1308 (P7-2): a session token uploads one file into its own session.
    /^\/api\/sessions\/[^/]+\/attachments$/u.test(pathname)
  ) {
    return 'POST';
  }
  return null;
}

/** The token of a `Bearer <token>` header when it starts with `prefix`, else false. */
function hasBearerPrefix(authorization: string | null, prefix: string): boolean {
  const bearer = authorization === null ? null : /^Bearer[ ]([^ ]+)$/iu.exec(authorization.trim());
  return bearer?.[1]?.startsWith(prefix) === true;
}

/**
 * Issue #236 (SDK-04, S-1): a browser token's credential shape only, scoped by prefix AND by the
 * exact path shapes §3.1's grammar admits — reading a run or its events, and starting a run in a
 * session. Issue #539 (S2-05c) adds a third shape, rating a run (`POST /api/runs/:id/feedback`),
 * whose session row identity the handler checks. Issue #251 adds the two presign shapes
 * (`POST /api/files/:id/(upload|download)-urls`), whose `.attachments/<sessionId>/` prefix the
 * handler checks. This is not the authorisation decision:
 * `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) still refuses a token whose scope
 * does not reach the row a matched path names, and the route still verifies the bearer itself. A
 * too-wide match here would let an unverified bearer past the edge for a shape `decide()` was never
 * asked about; pinned by `proxy.test.ts`.
 */
function isBrowserTokenExemptRoute(request: NextRequest, authorization: string | null): boolean {
  if (!hasBearerPrefix(authorization, 'awt_live_')) return false;
  return visitorRouteMethod(request.nextUrl.pathname) === request.method;
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
  if (!hasBearerPrefix(authorization, 'awu_live_')) return false;
  return isCliTokenRoutePath(request.nextUrl.pathname);
}

/**
 * ADR-0161 D9: the credential shape of an access token from `POST /api/auth/token-exchange`,
 * admitted only on the `app-backend` grammar's routes (`server/auth/app-backend-routes.ts`). The
 * route resolves it, refuses one whose client is not an `app-backend` client, and `decide()`
 * narrows it to the client's bound agents; a bearer header is never sent by a browser on its own,
 * so these need no origin check.
 */
function isAppBackendTokenRoute(request: NextRequest, authorization: string | null): boolean {
  if (!hasBearerPrefix(authorization, 'awo_live_')) return false;
  return isAppBackendRoute(request.method, request.nextUrl.pathname);
}

/**
 * ADR-0144: Microsoft Graph and Zoom call a fixed URL with no session and no header, so the secret
 * in the path is the whole authentication, checked by the route. Exact by method and shape.
 */
function isTriggerFire(request: NextRequest): boolean {
  return (
    request.method === 'POST' &&
    /^\/api\/triggers\/[^/]+\/fire\/[^/]+$/u.test(request.nextUrl.pathname)
  );
}

/**
 * Issue #1846: the `aw-control` door takes a run token, which no other route does. It verifies the
 * token itself and refuses a cookie or an API key, so the edge lets exactly this method and path by.
 */
function isBuilderMcpRoute({ method, nextUrl }: NextRequest): boolean {
  return method === 'POST' && nextUrl.pathname === '/api/builder/mcp';
}

/**
 * Issue #1517 (ADR-0104 acceptance decision 4): a team lead run's member endpoint takes the lead
 * run's own run token, as the runner's session seam does. The route verifies the token again and
 * admits it only for the run its path names, so the edge lets exactly this method and shape by.
 */
function isTeamMemberMcpRoute({ method, nextUrl }: NextRequest): boolean {
  return method === 'POST' && /^\/api\/runs\/[^/]+\/members\/mcp$/u.test(nextUrl.pathname);
}

/** The routes that carry their own credential and check it themselves, so they need no session. */
function authenticatesItself(request: NextRequest): boolean {
  const { method, nextUrl } = request;
  return (
    isBuilderMcpRoute(request) ||
    isTeamMemberMcpRoute(request) ||
    isAgentEndpointRoute(method, nextUrl.pathname) ||
    isOAuthRoute(method, nextUrl.pathname) ||
    isTriggerFire(request)
  );
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

type Method = 'GET' | 'POST' | 'PUT';

/**
 * Pre-authentication routes by exact method and path.
 *
 * - Setup detection and submission are the only pre-authentication control-plane endpoints.
 * - Issue #118's OIDC sign-in exchange: `/api/auth/login` starts a transaction,
 *   `/api/auth/callback` is the identity provider's own `form_post` back to this application, and
 *   `/api/auth/workspace` may run with only the short-lived selection cookie the callback minted.
 *   Each does its own origin check where a state-changing method needs one, because exemption from
 *   this gate is also exemption from the `checkRequestOrigin` call.
 * - ADR-0161 D3: an app backend exchanges a person's ID token; the handler authenticates it.
 * - Spec §21, "Guest": email-link sign-in; each handler does its own same-origin check and limits.
 * - The Agent Store's lead form (own same-origin check, challenge and limit) and the privacy facts
 *   its notice page states.
 * - The Agent Store's maintenance list is public; the demo readiness and template routes are called
 *   with `Authorization: Bearer $AW_DEMO_OPERATOR_TOKEN`, which each route checks itself
 *   (`server/demo/operator.ts`).
 * - ADR-0120 clause 7 / ADR-0144 D5 / #1674: Vercel Cron sends only `Bearer $CRON_SECRET`, which the
 *   route checks itself.
 * - Issue #1562: the readiness probe; a kubelet sends no credential.
 */
const EXACT_PUBLIC_PATHS: Readonly<Record<Method, ReadonlySet<string>>> = {
  GET: new Set([
    '/api/setup/runtime-detect',
    '/api/auth/login',
    '/api/auth/workspace',
    '/api/store/privacy',
    '/api/store/demos',
    '/api/demo/readiness',
    '/api/demo/templates',
  ]),
  POST: new Set([
    '/api/setup',
    '/api/auth/callback',
    '/api/auth/workspace',
    '/api/auth/token-exchange',
    '/api/auth/email-link',
    '/api/auth/email-link/verify',
    '/api/store/leads',
  ]),
  PUT: new Set(),
};

const CRON_AND_PROBE_PATHS: ReadonlySet<string> = new Set([
  '/api/cron/retention',
  '/api/cron/triggers',
  '/api/cron/storage-cleanup',
  '/api/readyz',
]);

/**
 * Pre-authentication route shapes by method: the demo operator routes, and Issue #121's one
 * pre-membership operation (the acceptance handler verifies the invitation-identity cookie and
 * same-origin request itself; no other invitation route bypasses the tenant-session gate).
 */
const PUBLIC_PATH_SHAPES: Readonly<Record<Method, readonly RegExp[]>> = {
  GET: [],
  POST: [/^\/api\/invitations\/[^/]+\/accept$/u],
  PUT: [/^\/api\/demo\/(?:templates|maintenance|verification)\/[^/]+$/u],
};

function isPreAuthenticationRoute({ method, nextUrl }: NextRequest): boolean {
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') return false;
  const { pathname } = nextUrl;
  return (
    EXACT_PUBLIC_PATHS[method].has(pathname) ||
    PUBLIC_PATH_SHAPES[method].some((shape) => shape.test(pathname))
  );
}

function isCronOrProbeRoute({ method, nextUrl }: NextRequest): boolean {
  return method === 'GET' && CRON_AND_PROBE_PATHS.has(nextUrl.pathname);
}

/**
 * Routes admitted before the API-key gate: pre-authentication routes, the runner's session seam, and
 * routes that authenticate themselves (ADR-0135 A2A endpoints, ADR-0134 OAuth server routes,
 * ADR-0144 trigger fire URLs).
 */
export function passesBeforeApiKeyGate(
  request: NextRequest,
  authorization: string | null,
): boolean {
  return (
    isPreAuthenticationRoute(request) ||
    isRunnerSessionRoute(request, authorization) ||
    authenticatesItself(request)
  );
}

/** Routes admitted after the API-key gate: other credential shapes, cron and the readiness probe. */
export function passesAfterApiKeyGate(request: NextRequest, authorization: string | null): boolean {
  return (
    isBrowserTokenExemptRoute(request, authorization) ||
    isCliSignInRoute(request) ||
    isCliTokenRoute(request, authorization) ||
    isAppBackendTokenRoute(request, authorization) ||
    isCronOrProbeRoute(request)
  );
}
