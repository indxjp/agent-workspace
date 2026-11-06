/**
 * `signInRoutes`: the portal's sign-in (issue #1510, U3.6-b), an OpenID Connect code flow at the
 * app's issuer followed by ADR-0161's token exchange, so the app acts as the signed-in person and
 * never as its own key. Three route files, each one line over its import:
 *
 * ```ts
 * // app/api/sign-in/route.ts
 * export const GET = signInRoutes().start;
 * // app/api/sign-in/callback/route.ts
 * export const GET = signInRoutes().callback;
 * // app/api/sign-out/route.ts
 * export const POST = signInRoutes().signOut;
 * ```
 *
 * | Route                       | Does                                                              |
 * | --------------------------- | ----------------------------------------------------------------- |
 * | `GET /api/sign-in?next=`    | discovers the issuer and redirects to its `authorization_endpoint` |
 * | `GET /api/sign-in/callback` | checks the transaction, redeems the code, exchanges the ID token  |
 * | `POST /api/sign-out`        | clears the person's cookie                                        |
 *
 * The flow, in order:
 *
 * 1. `start` makes a state, a nonce and an S256 PKCE pair (RFC 7636) and keeps them, with the safe
 *    same-origin `next` path, in a signed, `HttpOnly`, 10-minute transaction cookie on
 *    `/api/sign-in`. The signature is an HMAC under a key derived from the app's issuer client
 *    secret, which only the server holds.
 * 2. The issuer signs the person in and redirects to `<the app's origin>/api/sign-in/callback`
 *    (ADR-0161 DI5 and DI11: the redirect URI is derived from the app's own origin).
 * 3. `callback` checks the cookie's signature and age and that `state` matches, redeems the code at
 *    the `token_endpoint` with `client_secret_basic` and the PKCE verifier, checks the ID token's
 *    `nonce`, and trades the ID token with `aw.auth.exchange` for an `awo_live_` token. The
 *    platform verifies the ID token's signature, issuer, audience and the person's membership
 *    (ADR-0161 D5); the app trusts no claim but `nonce`, which only binds the token to this
 *    transaction.
 * 4. It keeps the token in {@link PERSON_TOKEN_COOKIE} (`HttpOnly`, `SameSite=Lax`, `Secure` on
 *    https, `Max-Age` the token's `expires_in`), which `currentPerson` reads, and redirects to
 *    `next`.
 *
 * Six variables configure it, read on each request through one `.strict()` schema
 * ({@link SIGN_IN_ENVIRONMENT_VARIABLES}): `AW_URL` and ADR-0161 DI11's five names. A missing or
 * invalid one is `503 sign_in_not_configured`, naming the variable and never its value. The issuer
 * and its endpoints must be `https:`; plain `http:` is admitted only on a loopback host and only
 * when `NODE_ENV` is not `production` (`aw dev`'s development issuer, ADR-0161 DI9).
 *
 * Every refusal is the one problem envelope (ADR-0075). A browser's navigation (`Accept` names
 * `text/html`) is redirected instead to `/sign-in?error=<code>`, the same code, so the sign-in page
 * says what happened in the person's language. A refusal of the exchange is passed on by its
 * ADR-0161 code (`subject_not_member`, `subject_token_invalid`, …) and status, never its words.
 * Nothing here logs or answers an ID token, a code, a verifier, a secret or a platform token.
 *
 * shortcut: re-sign-in every 300 s (ADR-0161 D2: the exchanged token has no refresh); upgrade to a
 * silent re-exchange with the stored ID token if journeys show the friction. The issuer keeps its
 * own session, so signing in again is one round trip.
 * shortcut: sign-out clears the app's cookie only; the exchanged token lives out its 300 s at the
 * platform. Upgrade when the platform revokes an exchanged token by its bearer.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  SUBJECT_TOKEN_MAX_LENGTH,
  TOKEN_EXCHANGE_PROBLEM_CODES,
  type TokenExchangeProblemCode,
} from '@indx-workspace/contracts/token-exchange';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import { PERSON_TOKEN_COOKIE } from './person.js';
import { NO_STORE, problem } from './problem.js';

/** The app's sign-in page, which the portal template writes. */
export const SIGN_IN_PATH = '/sign-in';

/** The callback the issuer redirects to, relative to the app's origin (ADR-0161 DI5). */
export const SIGN_IN_CALLBACK_PATH = '/api/sign-in/callback';

/** The variables the sign-in reads, and nothing else of the environment. */
export const SIGN_IN_ENVIRONMENT_VARIABLES = [
  'AW_URL',
  'AW_OIDC_ISSUER_URL',
  'AW_OIDC_CLIENT_ID',
  'AW_OIDC_CLIENT_SECRET',
  'AW_APP_CLIENT_ID',
  'AW_APP_CLIENT_SECRET',
] as const;

/** The transaction cookie: the state, nonce, PKCE verifier and `next` of one sign-in. */
const TRANSACTION_COOKIE = 'aw_sign_in';
const TRANSACTION_PATH = '/api/sign-in';
/** How long a sign-in may take between `start` and `callback`. */
const TRANSACTION_SECONDS = 600;
/** The HMAC key of the transaction cookie is derived from the client secret under this label. */
const TRANSACTION_KEY_LABEL = 'indx-workspace-app/sign-in-transaction/v1';
/** The longest `next` path kept. */
const NEXT_MAX_LENGTH = 2048;
/** An issuer's discovery answer is kept this long, then read again. */
const DISCOVERY_CACHE_MS = 5 * 60_000;
/** The scopes asked for: the ID token is all the exchange needs. */
const SCOPE = 'openid email profile';
/** An RFC 6749 `error` or a platform code, safe to pass on as a detail. */
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Every code the sign-in itself answers with, and its status. */
export const SIGN_IN_PROBLEM_STATUS = {
  sign_in_not_configured: 503,
  invalid_next: 400,
  sign_in_expired: 400,
  sign_in_state_mismatch: 400,
  issuer_refused: 401,
  issuer_unavailable: 502,
  upstream_failure: 502,
} as const;

type SignInProblemCode = keyof typeof SIGN_IN_PROBLEM_STATUS;

const STATUS: Readonly<Record<SignInProblemCode | TokenExchangeProblemCode, number>> = {
  ...TOKEN_EXCHANGE_PROBLEM_CODES,
  ...SIGN_IN_PROBLEM_STATUS,
};

const MESSAGES: Readonly<Record<SignInProblemCode | TokenExchangeProblemCode, string>> = {
  sign_in_not_configured: 'Sign-in is not configured for this app.',
  invalid_next: 'The page to return to after sign-in must be a path of this app.',
  sign_in_expired: 'The sign-in took too long or was started in another browser. Sign in again.',
  sign_in_state_mismatch: 'The sign-in answer does not belong to this sign-in. Sign in again.',
  issuer_refused: 'The identity provider did not sign you in.',
  issuer_unavailable: 'The identity provider did not answer as expected. Try again later.',
  upstream_failure: 'Agent Workspace did not answer as expected. Try again later.',
  token_exchange_not_configured: 'Agent Workspace does not accept this app’s sign-in yet.',
  invalid_client:
    'Agent Workspace does not know this app’s client. Check its client id and secret.',
  subject_token_invalid: 'Agent Workspace could not verify your sign-in.',
  subject_token_wrong_issuer: 'Agent Workspace does not trust this identity provider.',
  subject_token_wrong_audience: 'Agent Workspace does not accept sign-ins for this app’s client.',
  subject_not_member: 'You are not a member of this workspace. Ask an Owner to invite you.',
  rate_limited: 'Too many sign-ins. Wait a minute and try again.',
};

/** The sign-in's settings, from the environment. */
interface SignInConfig {
  readonly awUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appClientId: string;
  readonly appClientSecret: string;
  /** Whether `NODE_ENV` is `production`: plain `http:` is then refused even on loopback. */
  readonly production: boolean;
}

const SignInEnvironmentSchema = z.strictObject({
  AW_URL: z.url({ protocol: /^https?$/u }),
  AW_OIDC_ISSUER_URL: z.url({ protocol: /^https?$/u }),
  AW_OIDC_CLIENT_ID: z.string().min(1).max(255),
  AW_OIDC_CLIENT_SECRET: z.string().min(1).max(1024),
  AW_APP_CLIENT_ID: z.string().min(1).max(255),
  AW_APP_CLIENT_SECRET: z.string().min(1).max(1024),
});

/** The parts of an issuer's discovery document the flow uses; the rest is ignored. */
const DiscoverySchema = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
});

/** The token endpoint's answer: only the ID token is read. */
const TokenAnswerSchema = z.looseObject({
  id_token: z.string().min(1).max(SUBJECT_TOKEN_MAX_LENGTH),
});

const TokenErrorSchema = z.looseObject({ error: z.string() });

/** The ID token's claims the app checks itself: only the `nonce` it sent. */
const NonceClaimSchema = z.looseObject({ nonce: z.string() });

/** The transaction cookie's payload. Owned, so strict. */
const TransactionSchema = z.strictObject({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(43).max(128),
  next: z.string().min(1).max(NEXT_MAX_LENGTH),
  expiresAt: z.number().int().positive(),
});

type Transaction = z.infer<typeof TransactionSchema>;

interface Discovery {
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
}

/** A Next.js route handler on Web-standard `Request` and `Response`. */
export type SignInHandler = (request: Request) => Promise<Response>;

/** The three handlers {@link signInRoutes} returns. */
export interface SignInRoutes {
  /** `GET /api/sign-in?next=`: redirects to the issuer. */
  readonly start: SignInHandler;
  /** `GET /api/sign-in/callback`: signs the person in and redirects to `next`. */
  readonly callback: SignInHandler;
  /** `POST /api/sign-out`: clears the person's cookie and redirects to the sign-in page. */
  readonly signOut: SignInHandler;
}

/** What {@link signInRoutes} may be given; each has a default. */
export interface SignInRoutesOptions {
  /** Where the variables are read; `process.env` when not given. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** The `fetch` the issuer and Agent Workspace are called with; the global one when not given. */
  readonly fetch?: typeof fetch;
  /** The clock, in milliseconds; `Date.now` when not given. */
  readonly now?: () => number;
}

/** A refusal raised inside a handler, answered by {@link refuse}. */
class SignInRefusal extends Error {
  readonly code: SignInProblemCode | TokenExchangeProblemCode;
  readonly status: number;
  readonly details: readonly string[] | undefined;

  constructor(
    code: SignInProblemCode | TokenExchangeProblemCode,
    options: { readonly status?: number; readonly details?: readonly string[] } = {},
  ) {
    super(MESSAGES[code]);
    this.name = 'SignInRefusal';
    this.code = code;
    this.status = options.status ?? STATUS[code];
    this.details = options.details;
  }
}

/**
 * The sign-in page's path, with `next` when it is a safe path of the app: what a page or a route
 * links or redirects to when `currentPerson` is `null`.
 */
export function signInHref(next?: string): string {
  const safe = next === undefined ? undefined : safeNext(next);
  return safe === undefined || safe === '/'
    ? SIGN_IN_PATH
    : `${SIGN_IN_PATH}?next=${encodeURIComponent(safe)}`;
}

/**
 * `value` when it is a path of this app's own origin to return to, else `undefined`: it starts with
 * one `/`, carries no backslash and no control character, and resolves to the same origin.
 */
function safeNext(value: string): string | undefined {
  if (value.length === 0 || value.length > NEXT_MAX_LENGTH) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  if ([...value].some((character) => character < ' ' || character === '\u007f')) return undefined;
  const base = 'http://app.invalid';
  const resolved = new URL(value, base);
  return resolved.origin === base
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : undefined;
}

function configOf(environment: Readonly<Record<string, string | undefined>>): SignInConfig {
  const parsed = SignInEnvironmentSchema.safeParse(
    Object.fromEntries(SIGN_IN_ENVIRONMENT_VARIABLES.map((name) => [name, environment[name]])),
  );
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new SignInRefusal('sign_in_not_configured', { details: names });
  }
  const data = parsed.data;
  return {
    awUrl: data.AW_URL,
    issuer: data.AW_OIDC_ISSUER_URL,
    clientId: data.AW_OIDC_CLIENT_ID,
    clientSecret: data.AW_OIDC_CLIENT_SECRET,
    appClientId: data.AW_APP_CLIENT_ID,
    appClientSecret: data.AW_APP_CLIENT_SECRET,
    production: environment['NODE_ENV'] === 'production',
  };
}

/**
 * Whether `url` may be called: `https:`, or plain `http:` on a loopback host outside production
 * (ADR-0161 DI9).
 */
function isTrustedIssuerUrl(url: URL, production: boolean): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && !production && LOOPBACK_HOSTS.has(url.hostname);
}

function trustedUrl(value: string, production: boolean): URL {
  const url = new URL(value);
  if (!isTrustedIssuerUrl(url, production)) {
    throw new SignInRefusal('sign_in_not_configured', { details: ['AW_OIDC_ISSUER_URL'] });
  }
  return url;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function random(bytes: number): string {
  return base64url(randomBytes(bytes));
}

function transactionKey(config: SignInConfig): Buffer {
  return createHmac('sha256', config.clientSecret).update(TRANSACTION_KEY_LABEL).digest();
}

function sealTransaction(config: SignInConfig, transaction: Transaction): string {
  const payload = base64url(Buffer.from(JSON.stringify(transaction), 'utf8'));
  const mac = base64url(createHmac('sha256', transactionKey(config)).update(payload).digest());
  return `${payload}.${mac}`;
}

function openTransaction(
  config: SignInConfig,
  sealed: string | undefined,
  now: number,
): Transaction {
  const value = sealed ?? '';
  const [payload, mac, ...rest] = value.split('.');
  if (payload === undefined || mac === undefined || rest.length > 0 || payload.length === 0) {
    throw new SignInRefusal('sign_in_expired');
  }
  const expected = createHmac('sha256', transactionKey(config)).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new SignInRefusal('sign_in_expired');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new SignInRefusal('sign_in_expired');
  }
  const parsed = TransactionSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.expiresAt <= now) throw new SignInRefusal('sign_in_expired');
  return parsed.data;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

function cookie(
  name: string,
  value: string,
  options: { readonly path: string; readonly maxAge: number; readonly secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${String(options.maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** A `Host` header: a DNS name or an IPv4 or bracketed IPv6 address, and an optional port. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/u;

/**
 * The app's origin as the browser addressed it: the request's `Host` (Next.js rewrites the host of
 * `request.url` to the one it was bound to, `localhost` for `-H 127.0.0.1`), and `https:` when the
 * request was, or a proxy in front says so in `X-Forwarded-Proto`. The redirect URI is derived
 * from it, so it must be the one the issuer registered (ADR-0161 DI5).
 *
 * shortcut: a proxy must pass the browser's `Host` through; upgrade to an `AW_APP_URL` setting if
 * a deployment cannot.
 */
function originOf(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwarded === 'https' || forwarded === 'http' ? `${forwarded}:` : url.protocol;
  const host = request.headers.get('host');
  return `${protocol}//${host !== null && HOST.test(host) ? host : url.host}`;
}

function isSecure(request: Request): boolean {
  return originOf(request).startsWith('https:');
}

function clearTransaction(request: Request): string {
  return cookie(TRANSACTION_COOKIE, '', {
    path: TRANSACTION_PATH,
    maxAge: 0,
    secure: isSecure(request),
  });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, 'cache-control': NO_STORE });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}

function wantsPage(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * The answer of `refusal`: a browser's navigation goes to the sign-in page with the code, any
 * other caller gets the problem envelope. Either clears the transaction cookie.
 */
function refuse(request: Request, refusal: SignInRefusal): Response {
  const clear = clearTransaction(request);
  if (wantsPage(request)) {
    return redirect(`${originOf(request)}${SIGN_IN_PATH}?error=${refusal.code}`, [clear]);
  }
  const answer = problem(refusal.code, refusal.status, refusal.message, refusal.details);
  answer.headers.append('set-cookie', clear);
  return answer;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** `handler`, with every refusal and failure answered by {@link refuse} and logged by name only. */
function guarded(handler: SignInHandler): SignInHandler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof SignInRefusal) return refuse(request, error);
      console.error(`[@indx-workspace/app] a sign-in failed (${nameOf(error)})`);
      return refuse(request, new SignInRefusal('upstream_failure'));
    }
  };
}

async function fetched(call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch {
    throw new SignInRefusal('issuer_unavailable');
  }
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The issuer's endpoints, from its discovery document, each checked as the issuer is. */
async function discover(config: SignInConfig, fetchImpl: typeof fetch): Promise<Discovery> {
  trustedUrl(config.issuer, config.production);
  const url = `${config.issuer.replace(/\/+$/u, '')}/.well-known/openid-configuration`;
  const response = await fetched(() =>
    fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' }),
  );
  const parsed = DiscoverySchema.safeParse(response.ok ? await jsonOf(response) : undefined);
  if (!parsed.success || parsed.data.issuer !== config.issuer) {
    throw new SignInRefusal('issuer_unavailable');
  }
  return {
    authorizationEndpoint: trustedUrl(parsed.data.authorization_endpoint, config.production),
    tokenEndpoint: trustedUrl(parsed.data.token_endpoint, config.production),
  };
}

/** RFC 6749 §2.3.1: each half form-urlencoded, joined by `:`, then base64. */
function basic(clientId: string, clientSecret: string): string {
  const encode = (value: string): string => encodeURIComponent(value).replace(/%20/gu, '+');
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}

/** The issuer's `error` string when it is safe to show, as a detail. */
function issuerDetails(error: unknown): readonly string[] | undefined {
  return typeof error === 'string' && SAFE_CODE.test(error) ? [error] : undefined;
}

/** Redeems `code` at the token endpoint with `client_secret_basic` and the verifier. */
async function redeem(
  config: SignInConfig,
  context: {
    readonly discovery: Discovery;
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
    readonly fetch: typeof fetch;
  },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: context.code,
    redirect_uri: context.redirectUri,
    code_verifier: context.verifier,
  });
  const response = await fetched(() =>
    context.fetch(context.discovery.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: basic(config.clientId, config.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    }),
  );
  const answer = await jsonOf(response);
  if (!response.ok) {
    const error = TokenErrorSchema.safeParse(answer);
    const details = error.success ? issuerDetails(error.data.error) : undefined;
    throw new SignInRefusal('issuer_refused', details === undefined ? {} : { details });
  }
  const parsed = TokenAnswerSchema.safeParse(answer);
  if (!parsed.success) throw new SignInRefusal('issuer_unavailable');
  return parsed.data.id_token;
}

/** Whether the ID token carries the `nonce` this sign-in sent; its signature is the platform's. */
function carriesNonce(idToken: string, nonce: string): boolean {
  const [, payload] = idToken.split('.');
  if (payload === undefined) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const parsed = NonceClaimSchema.safeParse(claims);
  if (!parsed.success) return false;
  const given = createHash('sha256').update(parsed.data.nonce).digest();
  return timingSafeEqual(given, createHash('sha256').update(nonce).digest());
}

function isExchangeCode(code: string): code is TokenExchangeProblemCode {
  return Object.hasOwn(TOKEN_EXCHANGE_PROBLEM_CODES, code);
}

/** Trades the ID token for an `awo_live_` token, a refusal passed on by its ADR-0161 code. */
async function exchange(
  config: SignInConfig,
  idToken: string,
  fetchImpl: typeof fetch,
): Promise<{ readonly token: string; readonly expiresIn: number }> {
  const aw = createClient({ baseUrl: config.awUrl, auth: { kind: 'session' }, fetch: fetchImpl });
  try {
    const exchanged = await aw.auth.exchange({
      clientId: config.appClientId,
      clientSecret: config.appClientSecret,
      idToken,
    });
    return { token: exchanged.access_token, expiresIn: exchanged.expires_in };
  } catch (error) {
    if (error instanceof ApiProblemError && isExchangeCode(error.code)) {
      throw new SignInRefusal(error.code, { status: error.status });
    }
    throw new SignInRefusal('upstream_failure');
  }
}

/** The callback's query: the code, or the issuer's refusal; a missing or wrong state refuses. */
function callbackCode(url: URL, transaction: Transaction): string {
  const error = url.searchParams.get('error');
  if (error !== null) {
    const details = issuerDetails(error);
    throw new SignInRefusal('issuer_refused', details === undefined ? {} : { details });
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (state === null || code === null || code.length === 0) {
    throw new SignInRefusal('sign_in_state_mismatch');
  }
  const given = createHash('sha256').update(state).digest();
  const expected = createHash('sha256').update(transaction.state).digest();
  if (!timingSafeEqual(given, expected)) throw new SignInRefusal('sign_in_state_mismatch');
  return code;
}

/**
 * The portal's sign-in handlers. Nothing is read when they are made, so a route module loads
 * during `next build` without the variables; each request reads them again.
 */
export function signInRoutes(options: SignInRoutesOptions = {}): SignInRoutes {
  const environment = (): Readonly<Record<string, string | undefined>> =>
    options.environment ?? process.env;
  const fetchImpl = (): typeof fetch => options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached:
    { readonly issuer: string; readonly at: number; readonly value: Discovery } | undefined;

  const discovery = async (config: SignInConfig): Promise<Discovery> => {
    const at = now();
    if (cached?.issuer === config.issuer && at - cached.at < DISCOVERY_CACHE_MS)
      return cached.value;
    const value = await discover(config, fetchImpl());
    cached = { issuer: config.issuer, at, value };
    return value;
  };

  const start: SignInHandler = async (request) => {
    const config = configOf(environment());
    const url = new URL(request.url);
    const next = safeNext(url.searchParams.get('next') ?? '/');
    if (next === undefined) throw new SignInRefusal('invalid_next');
    const { authorizationEndpoint } = await discovery(config);
    const transaction: Transaction = {
      state: random(32),
      nonce: random(32),
      verifier: random(32),
      next,
      expiresAt: now() + TRANSACTION_SECONDS * 1000,
    };
    const authorize = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: `${originOf(request)}${SIGN_IN_CALLBACK_PATH}`,
      scope: SCOPE,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: base64url(createHash('sha256').update(transaction.verifier).digest()),
      code_challenge_method: 'S256',
    })) {
      authorize.searchParams.set(key, value);
    }
    return redirect(authorize.href, [
      cookie(TRANSACTION_COOKIE, sealTransaction(config, transaction), {
        path: TRANSACTION_PATH,
        maxAge: TRANSACTION_SECONDS,
        secure: isSecure(request),
      }),
    ]);
  };

  const callback: SignInHandler = async (request) => {
    const config = configOf(environment());
    const url = new URL(request.url);
    const transaction = openTransaction(config, cookieValue(request, TRANSACTION_COOKIE), now());
    const code = callbackCode(url, transaction);
    const next = safeNext(transaction.next);
    if (next === undefined) throw new SignInRefusal('invalid_next');
    const idToken = await redeem(config, {
      discovery: await discovery(config),
      code,
      redirectUri: `${originOf(request)}${SIGN_IN_CALLBACK_PATH}`,
      verifier: transaction.verifier,
      fetch: fetchImpl(),
    });
    if (!carriesNonce(idToken, transaction.nonce))
      throw new SignInRefusal('sign_in_state_mismatch');
    const exchanged = await exchange(config, idToken, fetchImpl());
    return redirect(`${originOf(request)}${next}`, [
      clearTransaction(request),
      cookie(PERSON_TOKEN_COOKIE, exchanged.token, {
        path: '/',
        maxAge: exchanged.expiresIn,
        secure: isSecure(request),
      }),
    ]);
  };

  const signOut: SignInHandler = (request) => {
    return Promise.resolve(
      redirect(`${originOf(request)}${SIGN_IN_PATH}`, [
        cookie(PERSON_TOKEN_COOKIE, '', { path: '/', maxAge: 0, secure: isSecure(request) }),
      ]),
    );
  };

  return { start: guarded(start), callback: guarded(callback), signOut: guarded(signOut) };
}
