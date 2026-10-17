/**
 * Cross-site request forgery, for a cookie-authenticated API — spec §24.
 *
 * Two defences, both of them somebody else's code rather than ours (spec §40):
 *
 *   1. `SameSite=Lax` on the session cookie, enforced by the browser. A cross-site `POST` does
 *      not carry the cookie at all, so it arrives unauthenticated and the gate answers 401. This
 *      is the primary control and it is set in `session.ts`, not here.
 *   2. The `Origin` header check below, which is OWASP's recommended supplement and the reason
 *      this file exists: it does not depend on the browser having implemented `SameSite`
 *      correctly, and it catches the same-site-different-origin case `Lax` does not.
 *
 * No CSRF token is minted, stored or compared. A synchroniser token would be a second secret to
 * generate, transport, store per session and rotate — that is the hand-rolled CSRF protection
 * this task was told not to write.
 *
 * ## Why this is deliberately a *host* comparison
 *
 * Comparing full origins (`scheme://host:port`) breaks every deployment behind a TLS-terminating
 * proxy, where the browser says `https://app.example.com` and the app sees `http://web:3000`.
 * That failure is total and silent-looking — every write in the product returns 403 — so the
 * comparison is on host only, against the set of hosts this request could legitimately have been
 * addressed to. `X-Forwarded-Host` is in that set, and it is safe to include: a browser will not
 * let a cross-site page set it, so an attacker who can forge it is not attacking through a
 * browser and does not have the victim's cookie either.
 *
 * ## Absence is a rejection, not a pass
 *
 * A request with an unsafe method and **no** `Origin` header is rejected. Every browser has sent
 * `Origin` on unsafe methods for years, so this costs no browser anything; it costs a `curl`
 * client one flag, which is the correct price for a state-changing request against a
 * cookie-authenticated API. ADR-0015: the absence of the input a check needs is not the absence
 * of the risk it checks for.
 */

/** RFC 9110 safe methods, plus `OPTIONS`. Nothing here changes state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  readonly method: unknown;
  /** The `Origin` request header, or `null`/`undefined` when absent. */
  readonly origin: unknown;
  /** The host the application resolved for this request — `NextRequest.nextUrl.host`. */
  readonly requestHost: unknown;
  /** The `Host` header, if the runtime exposes it separately. */
  readonly hostHeader?: unknown;
  /** The `X-Forwarded-Host` header, if a proxy set one. */
  readonly forwardedHost?: unknown;
}

export type OriginVerdict =
  { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly reason: string };

/** An absolute URL, which is what `Origin` carries. Anything else is a bare authority. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * The host a header names, or `null` if it names none.
 *
 * The `try { new URL(v) } catch { treat as host:port }` shape this was first written with is
 * wrong, and wrong in the direction that matters. `new URL('app.example.com:3000')` does **not**
 * throw: `app.example.com` parses as a scheme, so the constructor succeeds and `.host` is the
 * empty string. Verification round 2 spotted it for `web:3000`; a scheme must begin with a letter,
 * so it is true of every bare `host:port` whose host starts with one — every DNS name, though not
 * `127.0.0.1:4711` or `[::1]:3000`, which throw and take the fallback. So the `X-Forwarded-Host`
 * of a proxy that includes a port contributed `''` to the expected set instead of its host, and
 * `''` in that set defeats the `expected.size === 0` guard below.
 *
 * The observable effect was a spurious 403 rather than a pass — measured: with
 * `Origin: https://app.example.com:3000`, `requestHost: web:3000` and
 * `X-Forwarded-Host: app.example.com:3000`, the expected set came out `['']` and the verdict was
 * `false`. So it was fail-closed, and it broke the proxy case this whole module exists to keep
 * working. A browser cannot reach the fail-open half of it either: it always sends
 * `scheme://host[:port]` or the literal `null`, both handled above.
 *
 * So: parse as a URL only when the value actually is one, take the first entry of a comma-joined
 * header list either way, and treat an empty host as no host.
 */
function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0]?.trim() ?? '';
  if (first.length === 0) return null;
  if (ABSOLUTE_URL.test(first)) {
    try {
      const host = new URL(first).host.toLowerCase();
      return host.length > 0 ? host : null;
    } catch {
      return null;
    }
  }
  // A bare `host:port`, which is what `Host` and `X-Forwarded-Host` carry.
  return first.toLowerCase();
}

/**
 * Decide whether a request may change state. Total: every input returns a verdict, and the
 * branch that cannot read its input rejects.
 */
export function checkRequestOrigin(input: OriginCheckInput): OriginVerdict {
  if (typeof input.method !== 'string' || input.method.length === 0) {
    return { ok: false, reason: 'request method is missing — refusing to treat it as safe' };
  }
  const method = input.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return { ok: true, reason: `${method} does not change state` };
  }

  if (typeof input.origin !== 'string' || input.origin.trim().length === 0) {
    return {
      ok: false,
      reason:
        `${method} carries no Origin header. Browsers always send one on an unsafe method; a ` +
        'non-browser client must send `Origin: <the base URL it is calling>`.',
    };
  }
  // `null` is what a sandboxed iframe or a redirected cross-origin request sends. It matches no
  // host and must not be treated as "same origin because it is not a different one".
  if (input.origin.trim() === 'null') {
    return { ok: false, reason: `${method} carries Origin: null, which matches no host` };
  }

  const originHost = hostOf(input.origin);
  if (originHost === null) {
    return { ok: false, reason: `${method} carries an Origin header that is not a URL` };
  }

  const expected = new Set(
    [hostOf(input.requestHost), hostOf(input.hostHeader), hostOf(input.forwardedHost)].filter(
      (host): host is string => host !== null,
    ),
  );
  if (expected.size === 0) {
    return { ok: false, reason: 'no host could be determined for this request — cannot compare' };
  }
  if (!expected.has(originHost)) {
    return {
      ok: false,
      reason: `Origin host "${originHost}" is none of ${[...expected].map((h) => `"${h}"`).join(', ')}`,
    };
  }
  return { ok: true, reason: `Origin host "${originHost}" matches the request host` };
}
