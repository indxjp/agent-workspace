/** Cross-origin and framing headers the edge gate adds: the Agent Store, visitor runs, surfaces. */
import { NextResponse, type NextRequest } from 'next/server';

import {
  readStoreOrigin,
  storeOriginFor,
  storePreflightAllowed,
  storePreflightHeaders,
  storeRouteKind,
  storeResponseHeaders,
} from './server/auth/store-origin';
import {
  preflightSurfaceSession,
  preflightVisitorRun,
  surfacePagePolicy,
} from './server/surfaces/public/handlers';
import { verifyRequestSession } from './proxy-session';

export function setHeaders(
  response: NextResponse,
  headers: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
}

/** What {@link storeOriginFor} needs of a request, with the session mark the caller verified. */
export function storeFacts(request: NextRequest, via: 'email_link' | null) {
  return {
    origin: request.headers.get('origin'),
    baseUrl: readStoreOrigin(process.env),
    method: request.method,
    pathname: request.nextUrl.pathname,
    via,
  };
}

/**
 * The CORS headers the Agent Store's origin gets on this answer, or `null`. The guest-session
 * routes grant only to a verified email-link session, so the cookie is read here too.
 */
export async function storeCors(
  request: NextRequest,
): Promise<Readonly<Record<string, string>> | null> {
  // Cheap guards first: a request from another origin, or to a route that is not the store's, never
  // pays for a second session verification (`gateRequest` already did one).
  const store = readStoreOrigin(process.env);
  if (store === null || request.headers.get('origin')?.trim() !== store) return null;
  const kind = storeRouteKind(request.method, request.nextUrl.pathname);
  if (kind === null) return null;
  // Only the guest-session set grants on a verified email-link session; the pre-session set needs none.
  let via: 'email_link' | null = null;
  if (kind === 'guest-session') {
    const session = await verifyRequestSession(request);
    via = session.ok ? (session.claims.via ?? null) : null;
    // A signed-out visitor (no session that verifies, no credential header) only ever gets the
    // gate's `401`, which holds no data. The store's page must be able to read it to say "sign in",
    // so that refusal carries the CORS grant too. A session that verifies but is not an email-link
    // one still gets none, so the store origin never reads a member's answer.
    if (!session.ok && request.headers.get('authorization') === null) {
      return storeResponseHeaders(store);
    }
  }
  const origin = storeOriginFor(storeFacts(request, via));
  return origin === null ? null : storeResponseHeaders(origin);
}

/** The Agent Store's CORS preflight answer for this request, or `null`. */
export function storePreflight(request: NextRequest): NextResponse | null {
  const asked = request.headers.get('access-control-request-method');
  const origin = request.headers.get('origin');
  if (
    request.method !== 'OPTIONS' ||
    !storePreflightAllowed(origin, readStoreOrigin(process.env), asked, request.nextUrl.pathname)
  ) {
    return null;
  }
  return new NextResponse(null, {
    status: 204,
    headers: storePreflightHeaders(origin?.trim() ?? '', asked ?? ''),
  });
}

/** The visitor run routes' CORS preflight answer (issue #680), or `null`. */
export async function visitorPreflight(
  request: NextRequest,
  visitorMethod: 'GET' | 'POST' | null,
): Promise<NextResponse | null> {
  if (visitorMethod === null || request.method !== 'OPTIONS') return null;
  return new NextResponse(null, {
    status: 204,
    headers: await preflightVisitorRun(visitorMethod, request.headers),
  });
}

/**
 * ADR-0105 slice 1, S1-17 (#455): the hosted surface page `GET /p/s/<name>` and everything below
 * it — its session bootstrap `POST /p/s/<name>/sessions` included — may be framed by this origin
 * only, except the page itself, which a surface's `allowedOrigins` may also frame (issue #622).
 * Matched case-sensitively, as `server/auth/paths.ts` classifies `/p`: `/P/s/x` is not a surface
 * path. A `/p/:token` share is not under `/p/s` and keeps its own headers.
 */
export function isSurfacePath(pathname: string): boolean {
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
 * token may call (issue #680) it is the control plane's only cross-origin surface.
 * Answered here, before any route, so no route file exports `OPTIONS`.
 */
export async function surfacePreflight(request: NextRequest): Promise<NextResponse | null> {
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
export async function surfacePolicy(request: NextRequest): Promise<string> {
  const name = request.method === 'GET' ? surfaceNameOf(request.nextUrl.pathname, '') : null;
  return name === null ? SURFACE_FRAME_ANCESTORS : surfacePagePolicy(name);
}
