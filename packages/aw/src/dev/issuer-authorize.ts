/** `/authorize` of the development issuer: the code flow with S256 PKCE and the sign-in form. */
import { z } from 'zod';

import { htmlAnswer, originOf, type IssuerAnswer } from './issuer-answer.js';
import { randomToken, sameSecret } from './issuer-crypto.js';
import { escapeHtml, formLocale, formPostPage, page, signInForm, TEXT } from './issuer-form.js';
import type { DevIssuerLocale } from './issuer-form.js';
import type { IssuerContext, IssuerSession, RegisteredClient } from './issuer-state.js';

/** The issuer session cookie (DI6). */
export const DEV_ISSUER_SESSION_COOKIE = 'aw_dev_issuer';

const CODE_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** A field of `/authorize`: at most 2 KiB, no control character. */
export const Field = z
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

/** What `/authorize` was asked, as the adapter read it. */
export interface AuthorizeInput {
  readonly method: 'GET' | 'POST';
  readonly parameters: Readonly<Record<string, string>>;
  readonly sessionId: string | undefined;
  readonly acceptLanguage: string | undefined;
}

type ResponseHeaders = Record<string, string>;

/** The redirect to the client carrying `parameters`, in the request's response mode. */
function respond(
  request: AuthorizeRequest,
  locale: DevIssuerLocale,
  parameters: Readonly<Record<string, string>>,
  headers: ResponseHeaders = {},
): IssuerAnswer {
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
}

function issueCode(
  context: IssuerContext,
  request: AuthorizeRequest,
  locale: DevIssuerLocale,
  session: IssuerSession,
  headers: ResponseHeaders = {},
): IssuerAnswer {
  const code = randomToken();
  context.codes.set(code, {
    clientId: request.client_id,
    redirectUri: request.redirect_uri,
    challenge: request.code_challenge,
    nonce: request.nonce,
    email: session.email,
    authTime: session.authTime,
    expiresAt: context.now() + CODE_TTL_MS,
  });
  return respond(request, locale, { code, iss: context.issuer }, headers);
}

/** The refusals that redirect back to the client (DI4's table), or `undefined`. */
function redirectedError(request: AuthorizeRequest): string | undefined {
  if (request.response_type !== 'code') return 'unsupported_response_type';
  if (!request.scope.split(' ').includes('openid')) return 'invalid_scope';
  return undefined;
}

function liveSession(context: IssuerContext, id: string | undefined): IssuerSession | undefined {
  const session = id === undefined ? undefined : context.sessions.get(id);
  if (session !== undefined && session.expiresAt > context.now()) return session;
  if (id !== undefined) context.sessions.delete(id);
  return undefined;
}

function sessionCookie(sessionId: string): string {
  return (
    `${DEV_ISSUER_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; ` +
    `Max-Age=${String(SESSION_TTL_MS / 1000)}`
  );
}

async function signIn(
  context: IssuerContext,
  request: AuthorizeRequest,
  locale: DevIssuerLocale,
  fields: Readonly<Record<string, string>>,
): Promise<IssuerAnswer> {
  const clientOrigin = originOf(request.redirect_uri);
  const retryAfter = context.limiter.retryAfter();
  const email = fields['email'] ?? context.defaultEmail;
  if (retryAfter !== undefined) {
    return htmlAnswer(429, signInForm(locale, request, email, 'limited'), {
      clientOrigin,
      headers: { 'retry-after': String(retryAfter) },
    });
  }
  const parsed = SignInFieldsSchema.safeParse(fields);
  const password = await context.readPassword();
  if (!parsed.success || password === undefined || !sameSecret(parsed.data.password, password)) {
    context.limiter.fail();
    return htmlAnswer(401, signInForm(locale, request, email, 'refused'), { clientOrigin });
  }
  const sessionId = randomToken();
  const session = {
    email: parsed.data.email.trim(),
    authTime: Math.floor(context.now() / 1000),
    expiresAt: context.now() + SESSION_TTL_MS,
  };
  context.sessions.set(sessionId, session);
  return issueCode(context, request, locale, session, { 'set-cookie': sessionCookie(sessionId) });
}

/** The error page for a request that names no usable client or return address. */
function errorPage(
  locale: DevIssuerLocale,
  error: 'invalid_client' | 'invalid_redirect_uri',
  explanation: string,
): IssuerAnswer {
  return htmlAnswer(400, page(locale, error, `<h1>${error}</h1><p>${escapeHtml(explanation)}</p>`));
}

/** A malformed request goes back to the registered return address as `invalid_request`. */
function malformedRequestRedirect(
  client: RegisteredClient,
  parameters: Readonly<Record<string, string | undefined>>,
): IssuerAnswer {
  const state = parameters['state'];
  const location = new URL(client.redirectUri);
  location.searchParams.set('error', 'invalid_request');
  if (state !== undefined && state !== '') location.searchParams.set('state', state);
  return htmlAnswer(302, '', {
    clientOrigin: location.origin,
    headers: { location: location.href },
  });
}

/** A valid request: refuse, sign in, reuse the session or show the form. */
async function answerValidRequest(
  context: IssuerContext,
  input: AuthorizeInput,
  request: AuthorizeRequest,
  locale: DevIssuerLocale,
  credentials: { readonly email?: string | undefined; readonly password?: string | undefined },
): Promise<IssuerAnswer> {
  const refused = redirectedError(request);
  if (refused !== undefined) return respond(request, locale, { error: refused });
  const { email, password } = credentials;
  if (input.method === 'POST' && (email !== undefined || password !== undefined)) {
    return signIn(context, request, locale, {
      ...(email === undefined ? {} : { email }),
      ...(password === undefined ? {} : { password }),
    });
  }
  const session = liveSession(context, input.sessionId);
  if (session !== undefined && request.prompt !== 'login') {
    return issueCode(context, request, locale, session);
  }
  if (request.prompt === 'none') return respond(request, locale, { error: 'login_required' });
  return htmlAnswer(200, signInForm(locale, request, context.defaultEmail, undefined), {
    clientOrigin: originOf(request.redirect_uri),
  });
}

export async function authorize(
  context: IssuerContext,
  input: AuthorizeInput,
): Promise<IssuerAnswer> {
  const locale = formLocale(input.acceptLanguage);
  const { email, password, ...rest } = input.parameters;
  const client = context.clients.get(rest['client_id'] ?? '');
  if (client === undefined) {
    return errorPage(locale, 'invalid_client', TEXT[locale].invalidClient);
  }
  if (rest['redirect_uri'] !== client.redirectUri) {
    return errorPage(locale, 'invalid_redirect_uri', TEXT[locale].invalidRedirect);
  }
  const parsed = AuthorizeRequestSchema.safeParse(rest);
  if (!parsed.success) return malformedRequestRedirect(client, rest);
  return answerValidRequest(context, input, parsed.data, locale, { email, password });
}
