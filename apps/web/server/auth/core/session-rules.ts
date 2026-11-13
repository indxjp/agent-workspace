/**
 * The session's rules, with no I/O and no clock of their own (refactoring part 06, step 2): what a
 * session's claims are, how a new one's are built, what makes a payload malformed, when a session
 * has expired or claims a longer life than this build issues, and the cookie that carries it.
 *
 * Signing and verifying the token stay in `../session.ts`, which owns the key: this module is a
 * `core/` and may not touch `crypto` (the `domain-core-is-pure` rule and the core globals ban).
 * `../session.ts` imports it with an explicit `.ts` path, which ADR W1-CP-06's amendment allows.
 */

/** Absolute lifetime. Not a sliding window: a session ends twelve hours after it began. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** The claims a Wave 1 session carries. Four roles arrive in W2-CP-06; this wave mints one. */
export interface SessionClaims {
  /** The bootstrap administrator's email address, lower-cased. */
  readonly sub: string;
  /** Workspace slug — the tenant this session is scoped to (spec §25). */
  readonly ws: string;
  /**
   * Not used for any decision: the role is read from the membership row on every request
   * (`rbac/principal.ts`). Still written as `'owner'` for one release so a build that requires it
   * accepts new cookies after a rollback; read as optional, and refused if present with any other
   * value (refactoring part 06, step 9).
   */
  readonly role?: 'owner';
  /** Issued at, seconds since the epoch. */
  readonly iat: number;
  /** Expires at, seconds since the epoch. */
  readonly exp: number;
}

/** Build the claims for a new session at `nowMs`. */
export function sessionClaimsAt(
  sub: string,
  ws: string,
  nowMs: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): SessionClaims {
  const iat = Math.floor(nowMs / 1000);
  return { sub, ws, role: 'owner', iat, exp: iat + ttlSeconds };
}

/** Why a session was refused once its signature verified. */
export type ClaimsRefusal = {
  readonly code: 'malformed_session' | 'expired_session';
  readonly reason: string;
};

/**
 * The claims a decoded payload carries, or why it is malformed. Checks in a fixed order, each
 * naming what it refused; a field that passes has the type and range the claims promise.
 */
export function parseSessionClaims(
  parsed: unknown,
):
  { readonly ok: true; readonly claims: SessionClaims } | ({ readonly ok: false } & ClaimsRefusal) {
  const malformed = (reason: string) => ({
    ok: false as const,
    code: 'malformed_session' as const,
    reason,
  });
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return malformed('payload is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const sub = record['sub'];
  const ws = record['ws'];
  const role = record['role'];
  const iat = record['iat'];
  const exp = record['exp'];
  if (typeof sub !== 'string' || sub.length === 0)
    return malformed('sub is missing or not a non-empty string');
  if (typeof ws !== 'string' || ws.length === 0)
    return malformed('ws is missing or not a non-empty string');
  if (role !== undefined && role !== 'owner')
    return malformed(`role ${JSON.stringify(role)} is not a role this build accepts`);
  if (typeof iat !== 'number' || !Number.isFinite(iat))
    return malformed('iat is missing or not a finite number');
  if (typeof exp !== 'number' || !Number.isFinite(exp))
    return malformed('exp is missing or not a finite number');
  if (exp <= iat) return malformed('exp is not after iat');
  return {
    ok: true,
    claims: role === undefined ? { sub, ws, iat, exp } : { sub, ws, role, iat, exp },
  };
}

/**
 * Whether well-formed claims still hold at `nowMs`: expiry first, then a lifetime longer than this
 * build issues. `null` when the session is current.
 */
export function sessionTimeRefusal(claims: SessionClaims, nowMs: number): ClaimsRefusal | null {
  // The fields were parsed and type-checked, so this comparison cannot be `NaN < now`.
  if (claims.exp * 1000 <= nowMs) return { code: 'expired_session', reason: 'session expired' };
  if (claims.exp - claims.iat > SESSION_TTL_SECONDS) {
    return {
      code: 'malformed_session',
      reason: 'session lifetime exceeds the maximum this build issues',
    };
  }
  return null;
}

/**
 * Cookie attributes, in the shape `cookies().set()` and `NextResponse.cookies.set()` both take.
 *
 * `secure: true` is unconditional. Making it depend on the request's scheme is the classic
 * downgrade: an attacker who can force one plain-HTTP request gets a cookie without it. Browsers
 * exempt `http://localhost` from the `Secure` requirement, so development works; a deployment
 * served over plain HTTP on any other host cannot hold a session, and that is the intended
 * answer rather than an oversight. See docs/adr/W1-CP-06-the-session-cookie-is-always-secure.md.
 */
export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

/** `name` is the deployment's session cookie name; the caller passes it, never a default. */
export function sessionCookie(
  token: string,
  name: string,
  maxAgeSeconds: number = SESSION_TTL_SECONDS,
): SessionCookie {
  return {
    name,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** The same cookie with an immediate expiry — sign-out. */
export function clearedSessionCookie(name: string): SessionCookie {
  return { ...sessionCookie('', name), value: '', maxAge: 0 };
}
