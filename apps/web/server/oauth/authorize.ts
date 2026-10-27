/**
 * `GET`/`POST /oauth/authorize` (OAuth 2.1 authorization code with PKCE `S256`; ADR-0134 part 3).
 *
 * The consenting member must hold a browser session — an API key or an OAuth token cannot approve
 * a grant — and may only authorise a client of their own workspace, for agents they can run. An
 * unknown client or an unregistered `redirect_uri` is shown to the member and never redirected to;
 * every other refusal goes back to the registered `redirect_uri`. The code is bound to the
 * `code_challenge` and `redirect_uri` and is good for 60 seconds, once.
 */
import { isUuid } from '@indx-workspace/contracts';

import { applicationContext } from '../application-context';
import { checkRequestOrigin } from '../auth/origin';
import type { Principal } from '../rbac/principal';
import {
  oauthError,
  oauthNotConfigured,
  oauthRateLimited,
  oauthUnavailable,
  readForm,
  type OAuthErrorCode,
} from './http';
import { admitOAuthSession } from './limits';
import { publicOrigin, resourceUrl } from './resource';
import type { OAuthClient, OAuthRuntime } from './runtime';
import { OAUTH_SCOPE } from './token';
import { isPkceChallenge, mintOAuthToken, OAUTH_TOKEN_TTL_MS } from './tokens';

type Evaluation =
  | { readonly kind: 'page-error'; readonly message: string }
  | { readonly kind: 'redirect-error'; readonly response: Response }
  | {
      readonly kind: 'ok';
      readonly client: OAuthClient;
      readonly resource: string;
      readonly redirectUri: string;
      readonly codeChallenge: string;
      readonly state: string | null;
    };

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
} as const;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (c) => `&#${String(c.codePointAt(0))};`);

const page = (status: number, title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: HTML_HEADERS },
  );

const errorPage = (message: string): Response =>
  page(400, 'Authorization failed', `<p>${escapeHtml(message)}</p>`);

function redirectTo(
  redirectUri: string,
  params: Readonly<Record<string, string | null>>,
  status: number,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return new Response(null, {
    status,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  });
}

async function evaluate(
  params: URLSearchParams,
  principal: Principal,
  runtime: OAuthRuntime,
  status: number,
): Promise<Evaluation> {
  const clientId = params.get('client_id');
  const client = clientId !== null && isUuid(clientId) ? await runtime.findClient(clientId) : null;
  // A client of another workspace is the same page as one that does not exist.
  if (client === null || client.workspaceId !== principal.workspaceId) {
    return { kind: 'page-error', message: 'This client is not known in your workspace.' };
  }
  const redirectUri = params.get('redirect_uri');
  if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
    return {
      kind: 'page-error',
      message: 'The redirect address is not registered for this client.',
    };
  }
  const state = params.get('state');
  const fail = (error: string, description: string): Evaluation => ({
    kind: 'redirect-error',
    response: redirectTo(
      redirectUri,
      { error, error_description: description, state, iss: publicOrigin() },
      status,
    ),
  });

  if (params.get('response_type') !== 'code') {
    return fail('unsupported_response_type', 'response_type must be code.');
  }
  const codeChallenge = params.get('code_challenge');
  if (
    params.get('code_challenge_method') !== 'S256' ||
    codeChallenge === null ||
    !isPkceChallenge(codeChallenge)
  ) {
    return fail('invalid_request', 'PKCE with code_challenge_method S256 is required.');
  }
  const scope = params.get('scope');
  if (scope !== null && scope.trim() !== OAUTH_SCOPE) {
    return fail('invalid_scope', `The only scope is "${OAUTH_SCOPE}".`);
  }
  const resource = client.resourcePath === null ? null : resourceUrl(client.resourcePath);
  const requested = params.get('resource');
  if (resource === null || (requested !== null && requested !== resource)) {
    return fail('invalid_target', "resource must be the client's resource URL.");
  }
  if (!(await runtime.canRunAll(principal, client.agentIds))) {
    return fail('access_denied', 'You cannot run every agent this client reaches.');
  }
  return { kind: 'ok', client, resource, redirectUri, codeChallenge, state };
}

function consentPage(
  principal: Principal,
  evaluation: Extract<Evaluation, { kind: 'ok' }>,
  agentNames: readonly string[],
  params: URLSearchParams,
): Response {
  const hidden = [...params.entries()]
    .filter(([key]) => key !== 'decision')
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return page(
    200,
    'Authorize access',
    `<p><strong>${escapeHtml(evaluation.client.name)}</strong> asks to act as ` +
      `<strong>${escapeHtml(principal.label)}</strong> at <code>${escapeHtml(evaluation.resource)}</code> ` +
      `for one hour, renewable until you revoke it.</p>` +
      (evaluation.client.kind === 'builder'
        ? `<p>It uses the Builder tools as you, with your role.</p>` +
          `<p>Registered by <strong>${escapeHtml(evaluation.client.creatorLabel ?? 'a member who has left')}</strong>. ` +
          `Approving sends you on to <code>${escapeHtml(new URL(evaluation.redirectUri).host)}</code>.</p>`
        : `<p>It reaches these agents:</p><ul>` +
          agentNames.map((name) => `<li>${escapeHtml(name)}</li>`).join('') +
          `</ul>`) +
      `<form method="post" action="/oauth/authorize">${hidden}` +
      `<button name="decision" value="approve">Authorize</button> ` +
      `<button name="decision" value="deny">Cancel</button></form>`,
  );
}

type Session = { readonly principal: Principal; readonly runtime: OAuthRuntime };

async function session(request: Request): Promise<Session | Response> {
  if (publicOrigin() === null) return oauthNotConfigured();
  const runtime = applicationContext()?.oauth ?? null;
  const rbac = applicationContext()?.rbac ?? null;
  if (runtime === null || rbac === null) return oauthUnavailable();
  const principal = await rbac.identify(request);
  if (principal === null) {
    const { pathname, search } = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: {
        location: `/signin?next=${encodeURIComponent(`${pathname}${search}`)}`,
        'cache-control': 'no-store',
      },
    });
  }
  if (principal.via !== 'session') {
    return oauthError(403, 'access_denied', 'Only a signed-in member can authorize a client.');
  }
  return { principal, runtime };
}

export async function authorizeGet(request: Request): Promise<Response> {
  const found = await session(request);
  if (found instanceof Response) return found;
  const params = new URL(request.url).searchParams;
  const evaluation = await evaluate(params, found.principal, found.runtime, 302);
  if (evaluation.kind === 'page-error') return errorPage(evaluation.message);
  if (evaluation.kind === 'redirect-error') return evaluation.response;
  const { client } = evaluation;
  const agentNames = await found.runtime.agentNames(client.workspaceId, client.agentIds);
  if (agentNames === null) return errorPage('An agent this client reaches no longer exists.');
  return consentPage(found.principal, evaluation, agentNames, params);
}

export async function authorizePost(request: Request): Promise<Response> {
  const found = await session(request);
  if (found instanceof Response) return found;
  const { principal, runtime } = found;

  const url = new URL(request.url);
  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: url.host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) return errorPage('This approval must come from the application itself.');
  const admitted = admitOAuthSession(principal.principalId, Date.now());
  if (!admitted.admitted) return oauthRateLimited(admitted.retryAfterSeconds);

  const form = await readForm(request);
  if (form instanceof Response) return form;
  const evaluation = await evaluate(form, principal, runtime, 303);
  if (evaluation.kind === 'page-error') return errorPage(evaluation.message);
  if (evaluation.kind === 'redirect-error') return evaluation.response;

  const { client, resource, redirectUri, codeChallenge, state } = evaluation;
  if (form.get('decision') !== 'approve') {
    const denied: OAuthErrorCode = 'access_denied';
    return redirectTo(redirectUri, { error: denied, state, iss: publicOrigin() }, 303);
  }
  const code = await mintOAuthToken('code');
  await (
    await runtime.tokens(client.workspaceId)
  ).issue({
    id: crypto.randomUUID(),
    clientId: client.id,
    kind: 'code',
    tokenHash: code.tokenHash,
    subjectPrincipalId: principal.principalId,
    resource,
    familyId: crypto.randomUUID(),
    codeChallenge,
    redirectUri,
    expiresAt: new Date(Date.now() + OAUTH_TOKEN_TTL_MS.code),
  });
  return redirectTo(redirectUri, { code: code.presented, state, iss: publicOrigin() }, 303);
}
