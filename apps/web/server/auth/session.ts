/**
 * The session token and the session cookie — spec §21 (bootstrap administrator), §24.
 *
 * ## What this is, and what it deliberately is not
 *
 * A session is a short-lived token that names the signed-in identity, MAC'd with HMAC-SHA-256
 * under a deployment secret, carried in a `__Host-` cookie. It is **not** a JWT: there is no
 * algorithm field to confuse, no header to negotiate, no `none`, and no library-shaped surface
 * for an attacker to aim at. The version tag is a constant that must match exactly.
 *
 * Every cryptographic operation here is a call into Web Crypto — `crypto.subtle.sign`,
 * `crypto.subtle.verify`, `crypto.getRandomValues`. Nothing in this file implements a primitive,
 * and nothing compares two secrets with `===`: `subtle.verify` is the constant-time comparison,
 * which is why the signature check is written as a verify rather than as a sign-then-compare.
 * Spec §40 makes a mature library mandatory for cryptography; Web Crypto is the platform's, is
 * present in both runtimes Next.js middleware can run in, and needs no dependency —
 * see docs/adr/W1-CP-06-web-crypto-instead-of-a-jwt-library.md for why a dependency was not the
 * option it looks like here.
 *
 * ## Reading order matters
 *
 * `verifySessionToken` rejects in a fixed order and names what it rejected at every step. The
 * order is not cosmetic: the signature is checked **before** the payload is parsed, so no
 * attacker-controlled JSON is ever handed to `JSON.parse` on the strength of a bad MAC, and
 * `exp` is parsed and type-checked **before** it is compared, so a missing or non-numeric expiry
 * cannot produce a `NaN < now` that is false and therefore reads as "not expired" (ADR-0015 —
 * this is the exact bug that shipped three times in Wave 0).
 */

/**
 * `__Host-` is a browser-enforced prefix: the cookie is rejected by the browser unless it is
 * `Secure`, `Path=/` and carries no `Domain`. That makes subdomain injection impossible without
 * anything on the server having to check for it.
 *
 * This is the name of a deployment that sets no `AW_INSTANCE_ID`; see {@link sessionCookieName}.
 */
export const DEFAULT_SESSION_COOKIE_NAME = '__Host-aw_session';

/**
 * Lowercase letters, digits, `-` and `_`: Compose's own rule for a project name, and a subset of
 * the cookie-name token characters, so the suffix can neither break the `Cookie` header nor
 * smuggle a second cookie into it.
 */
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
/** Room left for the readable part of a derived id: 63 minus `-` and an 8-digit hash. */
const DERIVED_PREFIX_LENGTH = 54;

/** FNV-1a, 32 bits, as 8 hex digits. A name suffix, not a security boundary; sync and edge-safe. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The cookie-name suffix for `AW_INSTANCE_ID`, or `undefined` when it is unset or blank.
 *
 * A valid id (see {@link INSTANCE_ID_PATTERN}) is used as written. Any other value — too long, or
 * with characters a cookie name cannot carry — is never refused at request time, which would fail
 * every request: it becomes its sanitised first 54 characters plus a hash of the whole value, so
 * two different ids still yield two different names. `agent-workspace start` and `validate` refuse
 * such a `COMPOSE_PROJECT_NAME` up front, so this is the path of a hand-set value only.
 */
export function cookieInstanceId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env['AW_INSTANCE_ID']?.trim() ?? '';
  if (raw.length === 0) return undefined;
  if (INSTANCE_ID_PATTERN.test(raw)) return raw;
  const readable = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, DERIVED_PREFIX_LENGTH);
  return readable.length === 0 ? shortHash(raw) : `${readable}-${shortHash(raw)}`;
}

/**
 * The deployment-scoped name of an auth cookie (issue #394): `<base>_<instance id>`, or `base`
 * when no `AW_INSTANCE_ID` is set.
 *
 * Browsers scope cookies by host, not by port, so two deployments on `localhost:3000` and
 * `localhost:3002` share one cookie jar, and under one fixed name each overwrote the other's
 * cookies. A generated Compose project passes its `COMPOSE_PROJECT_NAME` as `AW_INSTANCE_ID`.
 * Only a suffix is added, so a `__Host-` prefix and its rules (Secure, `Path=/`, no `Domain`) are
 * unchanged; the attributes come from each cookie's own builder. This is the one helper every
 * auth cookie's name goes through: the session cookie here, and the workspace-selection,
 * invitation-identity and OIDC-transaction cookies through `index.ts`, the composition root
 * (their modules import nothing, per docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md).
 */
export function scopedCookieName(
  base: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const instanceId = cookieInstanceId(env);
  return instanceId === undefined ? base : `${base}_${instanceId}`;
}

/**
 * The session cookie's name for this deployment: `__Host-aw_session_<id>`, or
 * {@link DEFAULT_SESSION_COOKIE_NAME} when `AW_INSTANCE_ID` is unset, so an existing deployment's
 * sessions survive an upgrade.
 *
 * Every reader and writer — the proxy, `getSession`, the route handlers that read the raw
 * `Cookie` header, and {@link sessionCookie} — calls this, so none can disagree about the name.
 */
export function sessionCookieName(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return scopedCookieName(DEFAULT_SESSION_COOKIE_NAME, env);
}

/** The only token format this build mints or accepts. */
const TOKEN_VERSION = 'aw1';

/** Absolute lifetime. Not a sliding window: a session ends twelve hours after it began. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * 32 characters. Shorter than this and the MAC key is the weak link; a deployment that has not
 * set one at all must not fall back to a generated or empty key, because "no secret configured"
 * would then mean "every forged token verifies against the same well-known key".
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

/** The claims a Wave 1 session carries. Four roles arrive in W2-CP-06; this wave mints one. */
export interface SessionClaims {
  /** The bootstrap administrator's email address, lower-cased. */
  readonly sub: string;
  /** Workspace slug — the tenant this session is scoped to (spec §25). */
  readonly ws: string;
  /** Spec §21's highest role. The only value this wave mints or accepts. */
  readonly role: 'owner';
  /** Issued at, seconds since the epoch. */
  readonly iat: number;
  /** Expires at, seconds since the epoch. */
  readonly exp: number;
}

/**
 * The same five fields, and one statement about where they came from that the type system
 * enforces: `verifySessionToken` returned them, which means `crypto.subtle.verify` accepted the
 * MAC over this exact payload.
 *
 * ## Why this is a class with a `#private` field, and not an interface
 *
 * The property that matters — a tenant is derived from a verified session and from nothing else
 * (spec §25) — is a statement about *provenance*, and a structural type cannot hold one. Before
 * this class existed, `workspaceScopeFrom` took an interface, so
 * `workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner', iat: 0, exp: 9e9 })`
 * compiled under `--strict` and produced a scope for whatever tenant the request body named.
 *
 * A phantom `unique symbol` brand was the first attempt and it is not enough: TypeScript keeps
 * symbol-keyed properties through an object spread, so `{ ...verified, ws: body.workspace }`
 * still type-checked. A `#private` field is dropped by spread and cannot be named, written or
 * satisfied from any other module, so both shapes are compile errors. `tests/auth.test.ts` runs
 * `tsc` over a fixture containing each of them and fails unless each is rejected by line.
 *
 * The class is deliberately **not exported as a value**: only the type below is. There is
 * therefore no constructor reachable from outside this module, and the only expression in the
 * program that produces one is in `verifySessionToken`, below the MAC check.
 *
 * `newSessionClaims` does **not** return this type. What that function builds is an unverified
 * payload on its way to being signed; letting it stand in here would reopen the hole. A test
 * that needs verified claims mints and verifies, which is four lines and exercises the real code:
 *
 * ```ts
 * const token = await mintSessionToken(newSessionClaims('a@b.test', 'default'), secret);
 * const result = await verifySessionToken(token, secret);
 * if (!result.ok) throw new Error(result.reason);
 * const claims = result.claims; // VerifiedSessionClaims
 * ```
 *
 * What this does not do: a deliberate `as` cast, or `Object.create` on the prototype, still
 * produces a value the compiler accepts. Nor does it stop the four lines in the block above being
 * run with a secret the caller invented rather than the deployment's — mint with it, verify with
 * it, and the result is a genuine `VerifiedClaims` naming any tenant the caller likes. Both
 * escapes are carried as `DECLARED` lines in the `tests/auth.test.ts` compile fixture, asserted
 * to produce no diagnostic, so they are on record as checked facts rather than as this comment.
 * The claim is that request data cannot become a tenant by accident or by the obvious shortcut —
 * not that a determined author cannot lie to the compiler, which is true of every type in the
 * program.
 */
class VerifiedClaims implements SessionClaims {
  public readonly sub: string;
  public readonly ws: string;
  public readonly role: 'owner';
  public readonly iat: number;
  public readonly exp: number;

  /**
   * Unnameable outside this file, and — unlike a symbol-keyed phantom property — not carried
   * across an object spread. It is what makes this type nominal. Not enumerable, so
   * `JSON.stringify` still produces exactly the five-field payload `mintSessionToken` signs.
   */
  readonly #verifiedBy = 'verifySessionToken';

  public constructor(claims: SessionClaims) {
    this.sub = claims.sub;
    this.ws = claims.ws;
    this.role = claims.role;
    this.iat = claims.iat;
    this.exp = claims.exp;
  }

  /** Reads the private field, and says in one word why this value may be trusted. */
  public get verifiedBy(): string {
    return this.#verifiedBy;
  }
}

/** Claims that came back from `verifySessionToken`. The type is exported; the class is not. */
export type VerifiedSessionClaims = VerifiedClaims;

export type SecretResult =
  { readonly ok: true; readonly secret: string } | { readonly ok: false; readonly reason: string };

export type VerifyResult =
  | { readonly ok: true; readonly claims: VerifiedSessionClaims }
  | { readonly ok: false; readonly code: VerifyFailure; readonly reason: string };

/**
 * A coarse classification of why verification failed. Coarse on purpose: it is safe to return to
 * an unauthenticated caller and useful to an operator reading a log, and it names no secret, no
 * environment variable and no identity.
 */
export type VerifyFailure =
  | 'no_session_cookie'
  | 'malformed_session'
  | 'invalid_signature'
  | 'expired_session'
  | 'server_not_configured';

/**
 * Read the deployment's session secret. A missing, blank or too-short value is a hard failure
 * that every caller must surface — never a default.
 */
export function readSessionSecret(env: Readonly<Record<string, string | undefined>>): SecretResult {
  const raw = env['SESSION_SECRET'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      reason:
        'SESSION_SECRET is not set. Sessions cannot be signed or verified, so every request to ' +
        '/api/** is refused. Set it to at least ' +
        `${String(MIN_SESSION_SECRET_LENGTH)} random characters and restart.`,
    };
  }
  const secret = raw.trim();
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return {
      ok: false,
      reason: `SESSION_SECRET is ${String(secret.length)} characters; the minimum is ${String(MIN_SESSION_SECRET_LENGTH)}.`,
    };
  }
  return { ok: true, secret };
}

/**
 * Importing a key is asynchronous and happens on every request through the gate, so the imported
 * key is memoised by secret. The map holds at most a handful of entries — one per distinct
 * secret a process has seen, which in practice is one.
 */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const keyCache = new Map<string, Promise<HmacKey>>();

function hmacKey(secret: string): Promise<HmacKey> {
  const cached = keyCache.get(secret);
  if (cached !== undefined) return cached;
  const created = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, created);
  return created;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The `Uint8Array<ArrayBuffer>` in the return type is not decoration: Web Crypto's `BufferSource`
 * excludes views backed by a `SharedArrayBuffer`, so a plain `Uint8Array` — whose buffer is
 * `ArrayBufferLike` — is not assignable to it. Allocating the buffer explicitly says which kind
 * it is.
 */
function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  const padding = (4 - (text.length % 4)) % 4;
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat(padding);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Mint a token for `claims`. The caller has already decided the claims are true. */
export async function mintSessionToken(claims: SessionClaims, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signed = `${TOKEN_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signed));
  return `${signed}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Build the claims for a new session. Separated from minting so the clock is one argument. */
export function newSessionClaims(
  sub: string,
  ws: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): SessionClaims {
  const iat = Math.floor(nowMs / 1000);
  return { sub, ws, role: 'owner', iat, exp: iat + ttlSeconds };
}

function reject(code: VerifyFailure, reason: string): VerifyResult {
  return { ok: false, code, reason };
}

/**
 * Verify a token. Rejects in a fixed order, naming what it rejected; there is no path through
 * this function that returns `ok` without a valid MAC, a well-formed payload and an expiry that
 * parsed as a finite number and is in the future.
 */
export async function verifySessionToken(
  token: unknown,
  secret: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return reject('no_session_cookie', 'no session cookie on the request');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return reject('malformed_session', `token has ${String(parts.length)} parts, expected 3`);
  }
  const [version, payloadPart, signaturePart] = parts;
  if (version !== TOKEN_VERSION || payloadPart === undefined || signaturePart === undefined) {
    return reject('malformed_session', 'token version tag is not the one this build issues');
  }

  const signature = base64UrlDecode(signaturePart);
  if (signature === null) {
    return reject('malformed_session', 'signature segment is not base64url');
  }

  // Constant-time, and before anything attacker-controlled is parsed.
  const signatureValid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(`${version}.${payloadPart}`),
  );
  if (!signatureValid) {
    return reject('invalid_signature', 'signature does not verify under this deployment secret');
  }

  const payloadBytes = base64UrlDecode(payloadPart);
  if (payloadBytes === null) {
    return reject('malformed_session', 'payload segment is not base64url');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return reject('malformed_session', 'payload is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('malformed_session', 'payload is not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const sub = record['sub'];
  const ws = record['ws'];
  const role = record['role'];
  const iat = record['iat'];
  const exp = record['exp'];

  if (typeof sub !== 'string' || sub.length === 0)
    return reject('malformed_session', 'sub is missing or not a non-empty string');
  if (typeof ws !== 'string' || ws.length === 0)
    return reject('malformed_session', 'ws is missing or not a non-empty string');
  if (role !== 'owner')
    return reject(
      'malformed_session',
      `role ${JSON.stringify(role)} is not a role this build accepts`,
    );
  if (typeof iat !== 'number' || !Number.isFinite(iat))
    return reject('malformed_session', 'iat is missing or not a finite number');
  if (typeof exp !== 'number' || !Number.isFinite(exp))
    return reject('malformed_session', 'exp is missing or not a finite number');
  if (exp <= iat) return reject('malformed_session', 'exp is not after iat');

  // Parsed and type-checked above, so this comparison cannot be `NaN < now`.
  if (exp * 1000 <= nowMs) {
    return reject('expired_session', 'session expired');
  }
  if (exp - iat > SESSION_TTL_SECONDS) {
    return reject('malformed_session', 'session lifetime exceeds the maximum this build issues');
  }

  // The one expression in the program that constructs verified claims, and it is reachable only
  // from below `crypto.subtle.verify` returning true and every field above being parsed and
  // range-checked. Every claim this task makes about tenant provenance reduces to this line, so
  // it is the line to read first when auditing it. Note that it is a constructor call and not a
  // cast: nothing here asserts a type the compiler could not check.
  return { ok: true, claims: new VerifiedClaims({ sub, ws, role, iat, exp }) };
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

export function sessionCookie(
  token: string,
  maxAgeSeconds: number = SESSION_TTL_SECONDS,
): SessionCookie {
  return {
    name: sessionCookieName(),
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** The same cookie with an immediate expiry — sign-out. */
export function clearedSessionCookie(): SessionCookie {
  return { ...sessionCookie(''), value: '', maxAge: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The bootstrap administrator — spec §21, §37
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bootstrap-password mode authenticates the identity that `pnpm db:seed` creates:
 * `packages/core/src/db/seed.ts` reads `BOOTSTRAP_ADMIN` and inserts that email as the workspace
 * owner. The same variable is read here, so the account you can sign in as and the account the
 * database holds are the same account by construction rather than by coincidence.
 *
 * Generic OIDC is implemented separately; this function deliberately covers only the bootstrap
 * credential path. RBAC resolves the signed-in user's current workspace role after authentication.
 *
 * The credential is never stored, never hashed at rest and never written to the database,
 * because the §27 schema has no credential column to write it to. The comparison is between the
 * value the operator configured and the value the caller typed, and it is constant-time.
 * `BOOTSTRAP_ADMIN_PASSWORD` is a new deployment-level variable; §37 names the identity half and
 * not the secret half, and the choice is recorded in
 * docs/adr/W1-CP-06-bootstrap-credential-is-a-deployment-value.md.
 *
 * This lives in the same module as the token deliberately, and not for taste: the modules under
 * `apps/web/server/auth` import nothing from each other, which is what lets Turbopack (which
 * resolves extensionless specifiers, not `./x.js`) and TypeScript's NodeNext program (which
 * requires `./x.js`) both read the same files. See
 * docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md.
 */

/**
 * Deliberately the same shape `packages/core/src/db/seed.ts` validates `BOOTSTRAP_ADMIN` with,
 * and the same shape the `users_email_shape` CHECK enforces in the database. Not an RFC 5322
 * parser; a shape check that rejects what actually causes trouble.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Same rule as the workspace slug CHECK in `packages/core/src/db/schema/workspaces.ts`. */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** The seed's default, repeated here so both halves agree when `WORKSPACE_SLUG` is unset. */
const DEFAULT_WORKSPACE_SLUG = 'default';

/**
 * Twelve characters is not a policy about password strength; it is a floor that makes an
 * accidentally-empty or placeholder value fail loudly at start-up rather than quietly become the
 * whole authentication story.
 */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

export interface BootstrapAdmin {
  /** Lower-cased, matching the row the seed inserted. */
  readonly email: string;
  readonly password: string;
  readonly workspaceSlug: string;
}

export type BootstrapAdminResult =
  | { readonly ok: true; readonly admin: BootstrapAdmin }
  | { readonly ok: false; readonly reason: string };

export type DeploymentWorkspaceSlugResult =
  { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly reason: string };

/**
 * The slug of the workspace this deployment serves (`WORKSPACE_SLUG`, default `default`). Needs
 * no sign-in credential, so OIDC-only deployments resolve it too. Pure string logic: `proxy.ts`
 * imports this module on the edge.
 */
export function readDeploymentWorkspaceSlug(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentWorkspaceSlugResult {
  const rawSlug = env['WORKSPACE_SLUG'];
  const slug =
    typeof rawSlug === 'string' && rawSlug.trim().length > 0
      ? rawSlug.trim()
      : DEFAULT_WORKSPACE_SLUG;
  if (!SLUG_SHAPE.test(slug)) {
    return { ok: false, reason: 'WORKSPACE_SLUG is not a usable lower-case URL-safe slug.' };
  }
  return { ok: true, slug };
}

/**
 * Resolve the bootstrap administrator from the environment. Every rejection names the variable
 * at fault, because the operator reading the server log is the only person who can fix it.
 */
export function readBootstrapAdmin(
  env: Readonly<Record<string, string | undefined>>,
): BootstrapAdminResult {
  const rawEmail = env['BOOTSTRAP_ADMIN'];
  if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0) {
    return {
      ok: false,
      reason:
        'BOOTSTRAP_ADMIN is not set. There is no default administrator identity: set it to the ' +
        'email address `pnpm db:seed` created the workspace owner with (spec §37).',
    };
  }
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) {
    return { ok: false, reason: 'BOOTSTRAP_ADMIN is not a usable email address.' };
  }

  const rawPassword = env['BOOTSTRAP_ADMIN_PASSWORD'];
  if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
    return {
      ok: false,
      reason:
        'BOOTSTRAP_ADMIN_PASSWORD is not set. Sign-in is refused rather than defaulted: set it ' +
        `to at least ${String(MIN_BOOTSTRAP_PASSWORD_LENGTH)} characters and restart.`,
    };
  }
  if (rawPassword.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason:
        `BOOTSTRAP_ADMIN_PASSWORD is ${String(rawPassword.length)} characters; the minimum is ` +
        `${String(MIN_BOOTSTRAP_PASSWORD_LENGTH)}.`,
    };
  }

  const slug = readDeploymentWorkspaceSlug(env);
  if (!slug.ok) return slug;

  return { ok: true, admin: { email, password: rawPassword, workspaceSlug: slug.slug } };
}

/**
 * Constant-time equality for two secrets, done the way that needs no primitive of our own: MAC
 * both strings under a key that exists for the duration of this call, and let `subtle.verify`
 * — which is constant-time by contract — do the comparison. HMAC's output is fixed-width, so the
 * *comparison* reveals nothing about how far the two values agreed, which is the leak that a
 * naive `===` has and the leak this function exists to remove.
 *
 * It does not hide length. Hashing an n-byte input costs ceil((n + 9) / 64) compression rounds,
 * so a very long candidate is measurably slower to reject than a short one. At the lengths a
 * password takes that is one round either way and far below the noise of a network round trip,
 * and the alternative — padding both inputs to a fixed width — would be a primitive of our own,
 * which §40 forbids. Stated rather than implied: content is not observable, length weakly is.
 */
async function secretsMatch(expected: string, given: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, mac, encoder.encode(given));
}

export interface SignInInput {
  readonly email: unknown;
  readonly password: unknown;
}

export type SignInResult =
  | { readonly ok: true; readonly token: string; readonly cookie: SessionCookie }
  | { readonly ok: false; readonly code: SignInFailure; readonly reason: string };

/**
 * `server_not_configured` is separated from `invalid_credentials` on purpose: they are the same
 * outcome for the caller and completely different outcomes for the operator, and collapsing them
 * is how a misconfigured deployment gets diagnosed as a forgotten password. Neither code names a
 * secret; the *reason* string is for the server log, not for the HTTP response body.
 */
export type SignInFailure = 'server_not_configured' | 'invalid_credentials' | 'malformed_request';

/** Verify credentials and mint a session. The only way a session cookie comes into existence. */
export async function signIn(
  input: SignInInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMs: number = Date.now(),
): Promise<SignInResult> {
  const secret = readSessionSecret(env);
  if (!secret.ok) {
    return { ok: false, code: 'server_not_configured', reason: secret.reason };
  }
  const configured = readBootstrapAdmin(env);
  if (!configured.ok) {
    return { ok: false, code: 'server_not_configured', reason: configured.reason };
  }

  if (typeof input.email !== 'string' || typeof input.password !== 'string') {
    return {
      ok: false,
      code: 'malformed_request',
      reason: 'sign-in requires an email and a password, both strings',
    };
  }

  // Both comparisons always run, so a wrong email and a wrong password cost the same.
  const emailMatches = await secretsMatch(configured.admin.email, input.email.trim().toLowerCase());
  const passwordMatches = await secretsMatch(configured.admin.password, input.password);
  if (!emailMatches || !passwordMatches) {
    return { ok: false, code: 'invalid_credentials', reason: 'email or password did not match' };
  }

  const claims = newSessionClaims(configured.admin.email, configured.admin.workspaceSlug, nowMs);
  const token = await mintSessionToken(claims, secret.secret);
  return { ok: true, token, cookie: sessionCookie(token, SESSION_TTL_SECONDS) };
}
