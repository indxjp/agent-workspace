/**
 * The Agent Store's browser origin, and the routes the platform lets it call (internal spec,
 * "The store app and how it reaches the platform").
 *
 * The store is a separate site (`AW_EMAIL_LINK_BASE_URL` is its origin), so its browser calls the
 * platform cross-origin with the visitor's cookie. Exactly one origin is ever allowed, and only on
 * two closed sets of routes:
 *
 * - the **pre-session** routes, which no cookie guards: sending a sign-in link, opening one, and
 *   the store's lead form;
 * - the **guest-session** routes, the few a demo visitor calls once signed in: who they are, the
 *   demo agents, listing, starting, reading, approving and interrupting their runs, and their
 *   allowance.
 *   These are allowed only to a session minted by an email link (`via: 'email_link'`). Any other
 *   session writing from the store origin stays refused (`403 cross_origin`).
 *
 * Unset, there is no store origin and nothing here grants anything. Pure: the environment value,
 * method, path and session mark are arguments, so every arm is tested without a server.
 */
import { CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';

import type { SignInSessionVia } from './core/session-rules';

/** Which of the two closed route sets a request is in. */
export type StoreRouteKind = 'pre-session' | 'guest-session';

const PRE_SESSION: readonly (readonly [method: string, path: RegExp])[] = [
  ['POST', /^\/api\/auth\/email-link$/u],
  ['POST', /^\/api\/auth\/email-link\/verify$/u],
  ['POST', /^\/api\/store\/leads$/u],
];

const GUEST_SESSION: readonly (readonly [method: string, path: RegExp])[] = [
  ['GET', /^\/api\/me$/u],
  ['GET', /^\/api\/agents$/u],
  ['POST', /^\/api\/agents\/[^/]+\/runs$/u],
  ['GET', /^\/api\/runs$/u],
  ['GET', /^\/api\/runs\/[^/]+$/u],
  ['GET', /^\/api\/runs\/[^/]+\/events$/u],
  ['POST', /^\/api\/runs\/[^/]+\/approval$/u],
  ['POST', /^\/api\/runs\/[^/]+\/interrupt$/u],
  ['GET', /^\/api\/demo\/allowance$/u],
];

/**
 * The origin of `AW_EMAIL_LINK_BASE_URL`, or `null` when it is unset or not an `http(s)` URL (the
 * settings refuse the latter at start-up; this stays total for the edge, which reads it live).
 */
export function storeOriginOf(baseUrl: string | null | undefined): string | null {
  if (baseUrl === null || baseUrl === undefined || baseUrl.trim().length === 0) return null;
  try {
    const url = new URL(baseUrl.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The store origin the deployment is configured with (`AW_EMAIL_LINK_BASE_URL`), or `null`. */
export function readStoreOrigin(env: Readonly<Record<string, string | undefined>>): string | null {
  return storeOriginOf(env['AW_EMAIL_LINK_BASE_URL']);
}

/** The set `method` and `pathname` are in, or `null` for any other route. */
export function storeRouteKind(method: string, pathname: string): StoreRouteKind | null {
  const verb = method.toUpperCase();
  const matches = (routes: typeof PRE_SESSION) =>
    routes.some(([routeMethod, path]) => routeMethod === verb && path.test(pathname));
  if (matches(PRE_SESSION)) return 'pre-session';
  return matches(GUEST_SESSION) ? 'guest-session' : null;
}

/** What a request says about itself, for {@link storeOriginFor}. */
export interface StoreRequestFacts {
  /** The `Origin` header, or `null` when absent. */
  readonly origin: string | null;
  /** `AW_EMAIL_LINK_BASE_URL` as set. */
  readonly baseUrl: string | null | undefined;
  readonly method: string;
  readonly pathname: string;
  /** The session cookie's mark when it verified; `null` for no verified session. */
  readonly via: SignInSessionVia | null;
}

/**
 * The store origin this request may use, or `null`: the request comes from the store origin, on a
 * route of the pre-session set, or on one of the guest-session set with an email-link session.
 */
export function storeOriginFor(request: StoreRequestFacts): string | null {
  const store = storeOriginOf(request.baseUrl);
  if (store === null || request.origin?.trim() !== store) return null;
  const kind = storeRouteKind(request.method, request.pathname);
  if (kind === 'pre-session') return store;
  return kind === 'guest-session' && request.via === 'email_link' ? store : null;
}

/** Whether the request is on a route the store origin may call at all, whatever the session. */
export function storePreflightAllowed(
  origin: string | null,
  baseUrl: string | null | undefined,
  askedMethod: string | null,
  pathname: string,
): boolean {
  const store = storeOriginOf(baseUrl);
  if (store === null || origin?.trim() !== store || askedMethod === null) return false;
  return storeRouteKind(askedMethod, pathname) !== null;
}

/** What the browser client may read besides the CORS-safelisted headers. */
const EXPOSED = ['retry-after', CONTRACTS_VERSION_HEADER].join(', ');

/**
 * The request headers the store's browser calls may carry: the JSON body's type, the contracts
 * version the SDK sends, and `last-event-id`, which `runs.follow` sends when it resumes a dropped
 * event stream.
 */
const ALLOWED = ['content-type', CONTRACTS_VERSION_HEADER, 'last-event-id'].join(', ');

/** Added to every answer of an allowed request, refusals included, so the store can read a `429`. */
export function storeResponseHeaders(origin: string): Readonly<Record<string, string>> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': EXPOSED,
    vary: 'origin',
  };
}

/** The `204` of a preflight for `method` from the store origin. */
export function storePreflightHeaders(
  origin: string,
  method: string,
): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': method.toUpperCase(),
    'access-control-allow-headers': ALLOWED,
    'access-control-max-age': '600',
    vary: 'origin',
  };
}
