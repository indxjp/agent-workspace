/**
 * Where the hosted surface page and its session bootstrap may be opened from (ADR-0105; S1-17,
 * issue #455; issue #622). The bootstrap hands a browser a session-scoped token with no sign-in,
 * so {@link mayOpenSession} admits a request on one of two branches, and refuses otherwise:
 *
 * - **Loopback** (ADR-0105 slice 1): a local runtime (contract C1) listening on loopback, asked
 *   over a loopback `Host`, by a page of the same origin — nobody but the publisher can reach it.
 * - **Allowed origin** (issue #622): the surface lists `allowedOrigins`, and the request comes
 *   from one of them, or from this origin's own page framed by one of them (the page's
 *   `frame-ancestors`, {@link frameAncestorsFor}, decides who may frame it).
 *
 * Each check fails closed — an unset or unreadable input is a failure, never a pass. Pure: the
 * surface, the environment and the request headers are arguments, so every arm is tested without
 * a server. The loopback checks run in ADR-0105's order and the first failure decides.
 */
import type { AgentEnvironment } from '@indx-workspace/contracts/agent-versions';
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';

import { isLoopbackHost } from '@agent-workspace/core/posture';

import { checkRequestOrigin } from '../../auth/origin';

/** Which of ADR-0105's four conditions refused the request. */
export type SurfaceConditionFailure = 'flag' | 'listen-host' | 'request-host' | 'same-origin';

/**
 * What {@link mayOpenSession} decided. `corsOrigin` is the allowed origin a cross-origin request
 * came from, to be echoed in `Access-Control-Allow-Origin`; `null` for a same-origin request.
 */
export type SurfaceOpenVerdict =
  | {
      readonly ok: true;
      readonly branch: 'loopback' | 'allowed-origin';
      readonly corsOrigin: string | null;
    }
  | { readonly ok: false; readonly failed: SurfaceConditionFailure | 'origin-not-allowed' };

/**
 * `page` for `GET /p/s/<name>` and its loader: a top-level or framed `GET` carries no reliable
 * `Origin`, so the origin half is not checked there; the bootstrap the page calls checks it.
 * `session` for `POST /p/s/<name>/sessions`.
 */
export type SurfaceOpenMode = 'page' | 'session';

/** The environment variables the conditions read. */
export type SurfaceConditionEnvironment = Readonly<Record<string, string | undefined>>;

/** The request headers the conditions read: a `Headers` or anything with its `get`. */
export interface SurfaceConditionHeaders {
  get(name: string): string | null;
}

/**
 * The host part of a `Host` header: `[::1]:3000` is `[::1]`, `localhost:3000` is `localhost`.
 * `null` for an empty value, a list, a bracketed address with no closing bracket, or anything
 * after the bracket that is not a port — a value this cannot read is not a loopback host.
 */
export function hostWithoutPort(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes(',')) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    const rest = trimmed.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/u.test(rest)) return null;
    return trimmed.slice(0, end + 1);
  }
  const colons = trimmed.split(':').length - 1;
  if (colons === 0) return trimmed;
  if (colons === 1) {
    const [host = '', port = ''] = trimmed.split(':');
    return host.length > 0 && /^\d{1,5}$/u.test(port) ? host : null;
  }
  // An IPv6 literal without brackets carries no port; `isLoopbackHost` reads `::1` as is.
  return trimmed;
}

/** Condition 1: the local runtime's flag (C1), exactly `1`. */
function flagSet(env: SurfaceConditionEnvironment): boolean {
  return env['AW_LOCAL_SURFACE_SESSIONS'] === '1';
}

/**
 * Condition 2: the process listens on loopback. The flag is set only by the local runtime (C1),
 * whose server is `startWeb`, and `startWeb` binds `HOST` and nothing else. So `HOST` must be set
 * and loopback: `next start` with no host binds every interface, so an unset `HOST` is not
 * loopback. `HOSTNAME` is not read: the runtime never binds it, and Docker, devcontainers and some
 * distributions export it as the machine's name, which says nothing about the listener.
 */
function listensOnLoopback(env: SurfaceConditionEnvironment): boolean {
  const host = env['HOST']?.trim() ?? '';
  return host.length > 0 && isLoopbackHost(host);
}

/**
 * Condition 3: the request was addressed to a loopback host, directly. Next.js itself sets
 * `X-Forwarded-Host` to the `Host` header on every request it serves, so its presence proves
 * nothing; a proxy in front of the runtime that names another host in it, though, means the
 * request may have come from anywhere. So a forwarded host, when present, must name the same host
 * and port as `Host`, which must be loopback.
 */
function addressedToLoopback(headers: SurfaceConditionHeaders): boolean {
  const hostHeader = headers.get('host');
  if (hostHeader === null) return false;
  const host = hostWithoutPort(hostHeader);
  if (host === null || !isLoopbackHost(host)) return false;
  const forwardedHost = headers.get('x-forwarded-host');
  return (
    forwardedHost === null || forwardedHost.trim().toLowerCase() === hostHeader.trim().toLowerCase()
  );
}

/**
 * Condition 4: the request comes from a page of this origin. `Origin` is required (the shared
 * CSRF check refuses its absence and `null` for an unsafe method), and `Sec-Fetch-Site`, when the
 * browser sends it, must say `same-origin` — `same-site` is another port or subdomain.
 * `readForwardedHost` also accepts `X-Forwarded-Host` as this origin's host, as the proxy's CSRF
 * check does, for an ingress that rewrites `Host`; a browser cannot set it. The loopback branch
 * does not need it: condition 3 already requires it to equal `Host`.
 */
function sameOrigin(headers: SurfaceConditionHeaders, readForwardedHost = false): boolean {
  // Asked as an unsafe method whatever the request's own, so a missing `Origin` is a refusal.
  const verdict = checkRequestOrigin({
    method: 'POST',
    origin: headers.get('origin'),
    requestHost: headers.get('host'),
    ...(readForwardedHost ? { forwardedHost: headers.get('x-forwarded-host') } : {}),
  });
  if (!verdict.ok) return false;
  const fetchSite = headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}

/** The first of ADR-0105's conditions `mode` checks that fails, or `null` when all hold. */
function loopbackFailure(
  env: SurfaceConditionEnvironment,
  headers: SurfaceConditionHeaders,
  mode: SurfaceOpenMode,
): SurfaceConditionFailure | null {
  if (!flagSet(env)) return 'flag';
  if (!listensOnLoopback(env)) return 'listen-host';
  if (!addressedToLoopback(headers)) return 'request-host';
  if (mode === 'session' && !sameOrigin(headers)) return 'same-origin';
  return null;
}

/** `http://localhost` or `http://127.0.0.1`, any port: what `aw dev` lets a surface's page call from. */
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/u;

/**
 * The default origin list of the local draft (issue #699): a surface served from the `local`
 * version that lists no origins allows the loopback origins on any port, so a developer's own app
 * on another port can embed the chat under `aw dev`. Only in the local environment (the local
 * runtime's flag, a loopback listener and a loopback `Host`, conditions 1 to 3), and never for a
 * `production` version: once the agent is promoted, visitors are served production's own list
 * (issue #733), and an origin the draft only defaults to is not one it lists.
 */
function localDefaultAllows(
  servedFrom: AgentEnvironment | null,
  env: SurfaceConditionEnvironment,
  headers: SurfaceConditionHeaders,
  origin: string | null,
): boolean {
  return (
    servedFrom === 'local' &&
    flagSet(env) &&
    listensOnLoopback(env) &&
    addressedToLoopback(headers) &&
    origin !== null &&
    LOCAL_ORIGIN.test(origin)
  );
}

/**
 * Whether `surface` may be opened by this request: the loopback branch first, unchanged from
 * ADR-0105 slice 1, then the allowed-origin branch. A surface that lists no origins (or none
 * resolved) is refused with the loopback condition that failed, unless it is the local draft
 * (`servedFrom` is `local`) and the local default admits the origin; one that lists origins, with
 * `origin-not-allowed`. `Origin` must equal a listed origin exactly; a missing or `null` one never
 * does. `servedFrom` is the environment whose version serves `surface`; `null` (unknown, or a
 * caller that asks only about listed origins) never gets the local default.
 */
export function mayOpenSession(
  surface: SurfaceDefinition | null,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment,
  mode: SurfaceOpenMode,
  servedFrom: AgentEnvironment | null = null,
): SurfaceOpenVerdict {
  const loopback = loopbackFailure(env, headers, mode);
  if (loopback === null) return { ok: true, branch: 'loopback', corsOrigin: null };
  const allowed = surface?.allowedOrigins ?? [];
  if (allowed.length === 0) {
    // An explicit list always wins; only a surface that lists none gets the local default.
    const origin = headers.get('origin');
    return surface !== null &&
      mode === 'session' &&
      localDefaultAllows(servedFrom, env, headers, origin)
      ? { ok: true, branch: 'allowed-origin', corsOrigin: origin }
      : { ok: false, failed: loopback };
  }
  if (mode === 'page' || sameOrigin(headers, true)) {
    return { ok: true, branch: 'allowed-origin', corsOrigin: null };
  }
  const origin = headers.get('origin');
  return origin !== null && allowed.includes(origin)
    ? { ok: true, branch: 'allowed-origin', corsOrigin: origin }
    : { ok: false, failed: 'origin-not-allowed' };
}

/** The `frame-ancestors` directive of a surface's page: this origin and its allowed origins. */
export function frameAncestorsFor(surface: SurfaceDefinition | null): string {
  return ["frame-ancestors 'self'", ...(surface?.allowedOrigins ?? [])].join(' ');
}
