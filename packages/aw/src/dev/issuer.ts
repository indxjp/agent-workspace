/**
 * Issue #2075, ADR-0161's 2026-11-01 amendment (DI1 to DI7): `aw dev`'s development OIDC issuer,
 * so a generated app signs a person in and acts as them by the platform's unchanged token exchange
 * on a developer's machine. It is a tool of the CLI and runs inside the `aw dev` process; the
 * platform never imports it, and the production posture refuses any non-`https:` issuer.
 *
 * - One `node:http` listener on `127.0.0.1` only, on the first free port from the web port + 200.
 *   A request whose `Host` is not exactly `127.0.0.1:<port>` is refused `421`.
 * - Four endpoints: discovery, the JWKS, `/authorize` (the code flow, S256 PKCE and `state`
 *   required, `query` or `form_post`) and `/token` (`client_secret_basic` only, single-use codes
 *   that live 60 seconds). Every other path is `404`.
 * - One Ed25519 key pair per process from `node:crypto`, held in memory only; ID tokens are
 *   compact EdDSA JWS signed with `node:crypto.sign`. No cryptography of its own beyond base64url.
 * - The person types a member's email and the local console password. The issuer reads no
 *   database: membership stays the platform's decision.
 *
 * Nothing it answers or logs carries a password, a code, a client secret or a token, except the
 * code in the redirect and the tokens in `/token`'s `200`.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { CommandRefusedError } from '../io.js';

/** How far past the web port the issuer's port starts, and how many ports are tried (DI1). */
export const DEV_ISSUER_PORT_OFFSET = 200;
export const DEV_ISSUER_PORT_SEARCH_LIMIT = 50;

/** The issuer session cookie (DI6). */
export const DEV_ISSUER_SESSION_COOKIE = 'aw_dev_issuer';

const CODE_TTL_MS = 60_000;
const ID_TOKEN_TTL_SECONDS = 600;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_SIGN_INS_PER_MINUTE = 10;
const MAX_BODY_BYTES = 16 * 1024;

/** Base64url of `bytes`. */
function base64url(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Constant-time equality of two strings' SHA-256 digests. */
function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

/** 32 random bytes, base64url (43 characters): a client secret, a code or a session id. */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The email as the issuer compares it: trimmed and lower-cased. */
function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** DI7: one email always has one `sub`: `local:` + base64url(SHA-256(the normalised email)). */
export function devIssuerSubject(email: string): string {
  return `local:${base64url(sha256(normalisedEmail(email)))}`;
}

/** The two languages the sign-in form speaks (DI6). */
export type DevIssuerLocale = 'en' | 'ja';

/** `ja` when the first language `Accept-Language` names that the form speaks is Japanese. */
export function formLocale(acceptLanguage: string | undefined): DevIssuerLocale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const [tag = '', ...parameters] = part.trim().toLowerCase().split(';');
    if (parameters.some((parameter) => /^q=0(?:\.0*)?$/u.test(parameter.trim()))) continue;
    if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
    if (tag === 'en' || tag.startsWith('en-') || tag === '*') return 'en';
  }
  return 'en';
}

const TEXT: Readonly<
  Record<
    DevIssuerLocale,
    {
      readonly title: string;
      readonly intro: string;
      readonly email: string;
      readonly password: string;
      readonly passwordHint: string;
      readonly submit: string;
      readonly refused: string;
      readonly limited: string;
      readonly continue: string;
      readonly invalidClient: string;
      readonly invalidRedirect: string;
    }
  >
> = {
  en: {
    title: 'Sign in to the local workspace',
    intro: 'aw dev’s development sign-in. Use a member’s email and the local console password.',
    email: 'Email',
    password: 'Local console password',
    passwordHint: 'aw dev prints where it is: your environment, .env or .agent-workspace/secrets.',
    submit: 'Sign in',
    refused: 'That email or password was not accepted.',
    limited: 'Too many attempts. Wait a minute and try again.',
    continue: 'Continue',
    invalidClient: 'This sign-in request names an application aw dev does not know.',
    invalidRedirect:
      'This sign-in request names a return address the application did not register.',
  },
  ja: {
    title: 'ローカルワークスペースにサインイン',
    intro:
      'aw dev の開発用サインインです。メンバーのメールアドレスとローカルコンソールのパスワードを入力してください。',
    email: 'メールアドレス',
    password: 'ローカルコンソールのパスワード',
    passwordHint: '保存場所は aw dev が表示します（環境変数、.env、.agent-workspace/secrets）。',
    submit: 'サインイン',
    refused: 'メールアドレスまたはパスワードが受け付けられませんでした。',
    limited: '試行回数が多すぎます。1 分ほど待ってからもう一度お試しください。',
    continue: '続ける',
    invalidClient: 'このサインイン要求は aw dev が知らないアプリケーションを指しています。',
    invalidRedirect: 'このサインイン要求の戻り先は、アプリケーションが登録したものではありません。',
  },
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${String(character.charCodeAt(0))};`);
}

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}' +
  'label{display:block;margin-top:1rem;font-weight:600}' +
  'input{display:block;width:100%;box-sizing:border-box;padding:.5rem;font:inherit}' +
  'button{margin-top:1.5rem;padding:.5rem 1rem;font:inherit}' +
  '[role=alert]{color:#a00;font-weight:600}' +
  ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}';

function page(locale: DevIssuerLocale, title: string, body: string): string {
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`
  );
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** The sign-in form (DI6): labelled fields, keyboard-operable, errors in an `aria-live` region. */
function signInForm(
  locale: DevIssuerLocale,
  request: AuthorizeRequest,
  email: string,
  error: 'refused' | 'limited' | undefined,
): string {
  const text = TEXT[locale];
  const carried = Object.entries(request)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => hidden(name, value))
    .join('');
  const message = error === undefined ? '' : escapeHtml(text[error]);
  return page(
    locale,
    text.title,
    `<h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.intro)}</p>` +
      `<div aria-live="assertive" role="alert" id="error">${message}</div>` +
      `<form method="post" action="/authorize">${carried}` +
      `<label for="email">${escapeHtml(text.email)}</label>` +
      `<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"` +
      `${error === undefined ? '' : ' aria-invalid="true" aria-describedby="error"'}>` +
      `<label for="password">${escapeHtml(text.password)}</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-hint"${error === undefined ? ' autofocus' : ''}>` +
      `<p id="password-hint">${escapeHtml(text.passwordHint)}</p>` +
      `<button type="submit">${escapeHtml(text.submit)}</button></form>`,
  );
}

/** The script that submits a `form_post` answer; its hash is the page's only `script-src`. */
const FORM_POST_SCRIPT = 'document.forms[0].submit();';
const FORM_POST_SCRIPT_HASH = `'sha256-${createHash('sha256').update(FORM_POST_SCRIPT).digest('base64')}'`;

/** The `form_post` answer: the parameters as a form the browser posts to the client. */
function formPostPage(
  locale: DevIssuerLocale,
  redirectUri: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const text = TEXT[locale];
  const fields = Object.entries(parameters)
    .map(([name, value]) => hidden(name, value))
    .join('');
  return page(
    locale,
    text.title,
    `<form method="post" action="${escapeHtml(redirectUri)}">${fields}` +
      `<button type="submit">${escapeHtml(text.continue)}</button></form>` +
      `<script>${FORM_POST_SCRIPT}</script>`,
  );
}

/** A field of `/authorize`: at most 2 KiB, no control character. */
const Field = z
  .string()
  .max(2048)
  .regex(/^[^\p{Cc}]*$/u);

/** The parameters `/authorize` reads (DI4); any other is a malformed request. */
const AuthorizeRequestSchema = z
  .object({
    client_id: Field,
    redirect_uri: Field,
    response_type: Field,
    scope: Field,
    state: Field.min(1),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    code_challenge_method: z.literal('S256'),
    response_mode: z.enum(['query', 'form_post']).optional(),
    nonce: Field.min(1).optional(),
    prompt: z.enum(['none', 'login', 'consent']).optional(),
  })
  .strict();
type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/** The sign-in form's own fields, posted beside the carried request. */
const SignInFieldsSchema = z
  .object({
    email: z.email().max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

/** The `/token` body (DI4). */
const TokenRequestSchema = z
  .object({
    grant_type: Field,
    code: Field.min(1),
    redirect_uri: Field.min(1),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
    client_id: Field.optional(),
  })
  .strict();

/** A client registered at the issuer for this process (DI5). */
interface RegisteredClient {
  readonly clientId: string;
  /** The SHA-256 of its secret: the secret itself is held only by whoever registered it. */
  readonly secretDigest: Buffer;
  readonly redirectUri: string;
}

interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | undefined;
  readonly email: string;
  readonly authTime: number;
  readonly expiresAt: number;
}

interface IssuerSession {
  readonly email: string;
  readonly authTime: number;
  readonly expiresAt: number;
}

/** An answer of the issuer, independent of the HTTP adapter. */
interface IssuerAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-type': 'text/html; charset=utf-8',
} as const;

/**
 * DI6's policy. `form-action` also names the client's origin, because browsers apply it to the
 * redirect that follows the form and to the `form_post` answer's form; a `form_post` page allows
 * its one script by hash. The smallest change that lets the ADR's flow complete in a browser.
 */
function contentSecurityPolicy(clientOrigin: string | undefined, script: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(script ? [`script-src ${FORM_POST_SCRIPT_HASH}`] : []),
    `form-action 'self'${clientOrigin === undefined ? '' : ` ${clientOrigin}`}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

function htmlAnswer(
  status: number,
  body: string,
  options: {
    readonly clientOrigin?: string;
    readonly script?: boolean;
    readonly headers?: Record<string, string>;
  } = {},
): IssuerAnswer {
  return {
    status,
    headers: {
      ...PAGE_HEADERS,
      'content-security-policy': contentSecurityPolicy(
        options.clientOrigin,
        options.script === true,
      ),
      ...options.headers,
    },
    body,
  };
}

function jsonAnswer(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): IssuerAnswer {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

function oauthError(status: number, error: string, headers: Record<string, string> = {}) {
  return jsonAnswer(status, { error }, headers);
}

/** The origin of `uri`, which the client registered and so parses. */
function originOf(uri: string): string {
  return new URL(uri).origin;
}

/** What `/authorize` was asked, as the adapter read it. */
interface AuthorizeInput {
  readonly method: 'GET' | 'POST';
  readonly parameters: Readonly<Record<string, string>>;
  readonly sessionId: string | undefined;
  readonly acceptLanguage: string | undefined;
}

/** The pure issuer: discovery, keys, the code flow and the token endpoint, with no I/O of its own. */
interface DevIssuerCore {
  readonly issuer: string;
  /** Register (or replace) a client with one redirect URI; returns its secret, never printed. */
  registerClient(clientId: string, redirectUri: string): string;
  discovery(): IssuerAnswer;
  jwks(): IssuerAnswer;
  authorize(input: AuthorizeInput): Promise<IssuerAnswer>;
  token(
    authorization: string | undefined,
    parameters: Readonly<Record<string, string>>,
  ): IssuerAnswer;
}

interface DevIssuerCoreOptions {
  /** `http://127.0.0.1:<port>`. */
  readonly issuer: string;
  /** The email the form is prefilled with: the project's bootstrap Owner. */
  readonly defaultEmail: string;
  /** The local console password, read when the form is posted; `undefined` when none is set. */
  readonly readPassword: () => Promise<string | undefined>;
  readonly now?: () => number;
}

interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
}

/** RFC 7638: the SHA-256 thumbprint of an OKP key's required members, in lexical order. */
function thumbprint(jwk: PublicJwk): string {
  return base64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));
}

function signer(privateKey: KeyObject, kid: string) {
  return (claims: Readonly<Record<string, unknown>>): string => {
    const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const payload = base64url(JSON.stringify(claims));
    const input = `${header}.${payload}`;
    return `${input}.${base64url(sign(null, Buffer.from(input), privateKey))}`;
  };
}

/** A per-minute counter of failed sign-ins: the issuer has one user, so one counter. */
function failureLimiter(now: () => number) {
  let windowStart = 0;
  let failures = 0;
  const roll = (): void => {
    if (now() - windowStart >= 60_000) {
      windowStart = now();
      failures = 0;
    }
  };
  return {
    retryAfter(): number | undefined {
      roll();
      return failures >= FAILED_SIGN_INS_PER_MINUTE
        ? Math.max(1, Math.ceil((windowStart + 60_000 - now()) / 1000))
        : undefined;
    },
    fail(): void {
      roll();
      failures += 1;
    },
  };
}

/** Parse `Authorization: Basic …` as RFC 6749 §2.3.1 encodes it, or `undefined`. */
function basicCredentials(
  authorization: string | undefined,
): { readonly id: string; readonly secret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(authorization ?? '');
  if (match?.[1] === undefined) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replaceAll('+', ' ')),
      secret: decodeURIComponent(decoded.slice(colon + 1).replaceAll('+', ' ')),
    };
  } catch {
    return undefined;
  }
}

/** The issuer's pure core (DI3 to DI7). */
function createDevIssuerCore(options: DevIssuerCoreOptions): DevIssuerCore {
  const { issuer } = options;
  const now = options.now ?? Date.now;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as PublicJwk;
  const kid = thumbprint(jwk);
  const signIdToken = signer(privateKey, kid);
  const clients = new Map<string, RegisteredClient>();
  const codes = new Map<string, IssuedCode>();
  const sessions = new Map<string, IssuerSession>();
  const limiter = failureLimiter(now);

  const liveSession = (id: string | undefined): IssuerSession | undefined => {
    const session = id === undefined ? undefined : sessions.get(id);
    if (session !== undefined && session.expiresAt > now()) return session;
    if (id !== undefined) sessions.delete(id);
    return undefined;
  };

  /** The redirect to the client carrying `parameters`, in the request's response mode. */
  const respond = (
    request: AuthorizeRequest,
    locale: DevIssuerLocale,
    parameters: Readonly<Record<string, string>>,
    headers: Record<string, string> = {},
  ): IssuerAnswer => {
    const withState = { ...parameters, state: request.state };
    const clientOrigin = originOf(request.redirect_uri);
    if (request.response_mode === 'form_post') {
      return htmlAnswer(200, formPostPage(locale, request.redirect_uri, withState), {
        clientOrigin,
        script: true,
        headers,
      });
    }
    const location = new URL(request.redirect_uri);
    for (const [name, value] of Object.entries(withState)) location.searchParams.set(name, value);
    return htmlAnswer(302, '', { clientOrigin, headers: { ...headers, location: location.href } });
  };

  const issueCode = (
    request: AuthorizeRequest,
    locale: DevIssuerLocale,
    session: IssuerSession,
    headers: Record<string, string> = {},
  ): IssuerAnswer => {
    const code = randomToken();
    codes.set(code, {
      clientId: request.client_id,
      redirectUri: request.redirect_uri,
      challenge: request.code_challenge,
      nonce: request.nonce,
      email: session.email,
      authTime: session.authTime,
      expiresAt: now() + CODE_TTL_MS,
    });
    return respond(request, locale, { code, iss: issuer }, headers);
  };

  /** The refusals that redirect back to the client (DI4's table), or `undefined`. */
  const redirectedError = (request: AuthorizeRequest): string | undefined => {
    if (request.response_type !== 'code') return 'unsupported_response_type';
    if (!request.scope.split(' ').includes('openid')) return 'invalid_scope';
    return undefined;
  };

  const signIn = async (
    request: AuthorizeRequest,
    locale: DevIssuerLocale,
    fields: Readonly<Record<string, string>>,
  ): Promise<IssuerAnswer> => {
    const clientOrigin = originOf(request.redirect_uri);
    const retryAfter = limiter.retryAfter();
    const email = fields['email'] ?? options.defaultEmail;
    if (retryAfter !== undefined) {
      return htmlAnswer(429, signInForm(locale, request, email, 'limited'), {
        clientOrigin,
        headers: { 'retry-after': String(retryAfter) },
      });
    }
    const parsed = SignInFieldsSchema.safeParse(fields);
    const password = await options.readPassword();
    if (!parsed.success || password === undefined || !sameSecret(parsed.data.password, password)) {
      limiter.fail();
      return htmlAnswer(401, signInForm(locale, request, email, 'refused'), { clientOrigin });
    }
    const sessionId = randomToken();
    const session = {
      email: parsed.data.email.trim(),
      authTime: Math.floor(now() / 1000),
      expiresAt: now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);
    const cookie =
      `${DEV_ISSUER_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; ` +
      `Max-Age=${String(SESSION_TTL_MS / 1000)}`;
    return issueCode(request, locale, session, { 'set-cookie': cookie });
  };

  const authorize = async (input: AuthorizeInput): Promise<IssuerAnswer> => {
    const locale = formLocale(input.acceptLanguage);
    const { email, password, ...rest } = input.parameters;
    const client = clients.get(rest['client_id'] ?? '');
    if (client === undefined) {
      return htmlAnswer(
        400,
        page(
          locale,
          'invalid_client',
          `<h1>invalid_client</h1><p>${escapeHtml(TEXT[locale].invalidClient)}</p>`,
        ),
      );
    }
    if (rest['redirect_uri'] !== client.redirectUri) {
      return htmlAnswer(
        400,
        page(
          locale,
          'invalid_redirect_uri',
          `<h1>invalid_redirect_uri</h1><p>${escapeHtml(TEXT[locale].invalidRedirect)}</p>`,
        ),
      );
    }
    const parsed = AuthorizeRequestSchema.safeParse(rest);
    if (!parsed.success) {
      const state = rest['state'];
      const location = new URL(client.redirectUri);
      location.searchParams.set('error', 'invalid_request');
      if (state !== undefined && state !== '') location.searchParams.set('state', state);
      return htmlAnswer(302, '', {
        clientOrigin: location.origin,
        headers: { location: location.href },
      });
    }
    const request = parsed.data;
    const refused = redirectedError(request);
    if (refused !== undefined) return respond(request, locale, { error: refused });
    if (input.method === 'POST' && (email !== undefined || password !== undefined)) {
      return signIn(request, locale, {
        ...(email === undefined ? {} : { email }),
        ...(password === undefined ? {} : { password }),
      });
    }
    const session = liveSession(input.sessionId);
    if (session !== undefined && request.prompt !== 'login')
      return issueCode(request, locale, session);
    if (request.prompt === 'none') return respond(request, locale, { error: 'login_required' });
    return htmlAnswer(200, signInForm(locale, request, options.defaultEmail, undefined), {
      clientOrigin: originOf(request.redirect_uri),
    });
  };

  const token = (
    authorization: string | undefined,
    parameters: Readonly<Record<string, string>>,
  ): IssuerAnswer => {
    const credentials = basicCredentials(authorization);
    const client = credentials === undefined ? undefined : clients.get(credentials.id);
    if (
      credentials === undefined ||
      client === undefined ||
      !timingSafeEqual(sha256(credentials.secret), client.secretDigest)
    ) {
      return oauthError(401, 'invalid_client', { 'www-authenticate': 'Basic realm="aw dev"' });
    }
    if (parameters['grant_type'] !== 'authorization_code') {
      return oauthError(
        400,
        parameters['grant_type'] === undefined ? 'invalid_request' : 'unsupported_grant_type',
      );
    }
    const parsed = TokenRequestSchema.safeParse(parameters);
    if (!parsed.success) return oauthError(400, 'invalid_request');
    const request = parsed.data;
    const code = codes.get(request.code);
    // Single use: a code is gone once presented, whatever the outcome.
    codes.delete(request.code);
    const verifierChallenge = base64url(sha256(request.code_verifier));
    if (
      code === undefined ||
      code.expiresAt <= now() ||
      code.clientId !== client.clientId ||
      (request.client_id !== undefined && request.client_id !== client.clientId) ||
      code.redirectUri !== request.redirect_uri ||
      verifierChallenge !== code.challenge
    ) {
      return oauthError(400, 'invalid_grant');
    }
    const iat = Math.floor(now() / 1000);
    const idToken = signIdToken({
      iss: issuer,
      sub: devIssuerSubject(code.email),
      aud: client.clientId,
      azp: client.clientId,
      email: code.email,
      email_verified: true,
      iat,
      auth_time: code.authTime,
      exp: iat + ID_TOKEN_TTL_SECONDS,
      ...(code.nonce === undefined ? {} : { nonce: code.nonce }),
    });
    return jsonAnswer(200, {
      access_token: randomToken(),
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_SECONDS,
      id_token: idToken,
    });
  };

  return {
    issuer,
    registerClient(clientId, redirectUri) {
      const secret = randomToken();
      clients.set(clientId, { clientId, secretDigest: sha256(secret), redirectUri });
      return secret;
    },
    discovery: () =>
      jsonAnswer(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        response_modes_supported: ['query', 'form_post'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['EdDSA'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      }),
    jwks: () => jsonAnswer(200, { keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] }),
    authorize,
    token,
  };
}

/** The value of `name` in a `Cookie` header, or `undefined`. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

class BodyTooLargeError extends Error {}

/** The request's body as text, refused past {@link MAX_BODY_BYTES}. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A form body's parameters, each named once; `undefined` when it is not form-encoded. */
async function formParameters(
  request: IncomingMessage,
): Promise<Record<string, string> | undefined> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return undefined;
  return singleValued(new URLSearchParams(await readBody(request)));
}

/** The parameters, or `undefined` when one is named twice. */
function singleValued(search: URLSearchParams): Record<string, string> | undefined {
  const parameters: Record<string, string> = {};
  for (const [name, value] of search) {
    if (Object.hasOwn(parameters, name)) return undefined;
    parameters[name] = value;
  }
  return parameters;
}

async function answer(
  core: DevIssuerCore,
  host: string,
  request: IncomingMessage,
): Promise<IssuerAnswer> {
  if (request.headers.host !== host) return jsonAnswer(421, { error: 'dev_issuer_wrong_host' });
  const url = new URL(request.url ?? '/', `http://${host}`);
  const method = request.method ?? 'GET';
  if (url.pathname === '/.well-known/openid-configuration' && method === 'GET') {
    return core.discovery();
  }
  if (url.pathname === '/jwks' && method === 'GET') return core.jwks();
  if (url.pathname === '/authorize' && (method === 'GET' || method === 'POST')) {
    const parameters =
      method === 'GET' ? singleValued(url.searchParams) : await formParameters(request);
    if (parameters === undefined) return oauthError(400, 'invalid_request');
    return core.authorize({
      method,
      parameters,
      sessionId: cookieValue(request.headers.cookie, DEV_ISSUER_SESSION_COOKIE),
      acceptLanguage: request.headers['accept-language'],
    });
  }
  if (url.pathname === '/token' && method === 'POST') {
    const parameters = await formParameters(request);
    if (parameters === undefined) return oauthError(400, 'invalid_request');
    return core.token(request.headers.authorization, parameters);
  }
  return jsonAnswer(404, { error: 'not_found' });
}

function send(response: ServerResponse, value: IssuerAnswer): void {
  response.writeHead(value.status, value.headers);
  response.end(value.body);
}

/** `aw dev`'s running issuer. */
export interface DevIssuer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** Register (or replace) a client; returns its secret, which is never printed. */
  registerClient(clientId: string, redirectUri: string): string;
  close(): Promise<void>;
}

export interface StartDevIssuerOptions {
  readonly webPort: number;
  readonly defaultEmail: string;
  readonly readPassword: () => Promise<string | undefined>;
  readonly now?: () => number;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the issuer on `127.0.0.1`, on the first free port from `webPort + 200` (50 tried), or
 * refuse with `dev_issuer_port_unavailable` (DI1).
 */
export async function startDevIssuer(options: StartDevIssuerOptions): Promise<DevIssuer> {
  let core: DevIssuerCore | undefined;
  let host = '';
  const server = createServer((request, response) => {
    if (core === undefined) {
      send(response, jsonAnswer(503, { error: 'temporarily_unavailable' }));
      return;
    }
    answer(core, host, request).then(
      (value) => {
        send(response, value);
      },
      (error: unknown) => {
        send(
          response,
          oauthError(error instanceof BodyTooLargeError ? 413 : 500, 'invalid_request'),
        );
      },
    );
  });
  for (let step = 0; step < DEV_ISSUER_PORT_SEARCH_LIMIT; step += 1) {
    const port = options.webPort + DEV_ISSUER_PORT_OFFSET + step;
    if (port > 65_535) break;
    if (!(await listen(server, port))) continue;
    host = `127.0.0.1:${String(port)}`;
    const url = `http://${host}`;
    const started = createDevIssuerCore({
      issuer: url,
      defaultEmail: options.defaultEmail,
      readPassword: options.readPassword,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    core = started;
    return {
      url,
      port,
      registerClient: (clientId, redirectUri) => started.registerClient(clientId, redirectUri),
      close: () =>
        new Promise((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    };
  }
  const first = options.webPort + DEV_ISSUER_PORT_OFFSET;
  throw new CommandRefusedError(
    `dev_issuer_port_unavailable: no free port from ${String(first)} to ${String(first + DEV_ISSUER_PORT_SEARCH_LIMIT - 1)} for the development OIDC issuer`,
    'stop what holds those ports, or start aw dev on another --port',
  );
}
