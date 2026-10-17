/**
 * `/api/auth/cli-verify` — issue #242 (SDK-10, S-22): where a signed-in person approves or denies
 * the user code `aw login` printed. ADR-0083.
 *
 * A `route.ts` that answers HTML, for the reason `/api/auth/workspace`'s `GET` is one: a single
 * form with no screen of its own in `ui/`. `GET` renders the form and changes nothing. `POST`
 * records the answer; it is reached only through `apps/web/proxy.ts`'s default gate, which
 * requires the session cookie and a same-origin request, and it checks both again here. Only a
 * browser session may approve: a bearer credential — an API key, a browser token, or another
 * CLI token — cannot sign a new CLI in.
 *
 * Every value written into the page is either a fixed string or a normalised user code (eight
 * letters of a fixed alphabet) or passes through {@link escapeHtml}. The page carries no inline
 * style: its own CSP (`default-src 'none'`) would block it, and `'unsafe-inline'` is not worth a
 * layout.
 *
 * RFC 8628 §5.4 (remote phishing): a link with `?code=` pre-fills the form, so an attacker could
 * mail a victim a link to approve the attacker's own code. Approval therefore needs an explicit
 * confirmation that the code shown is the one the person's own terminal printed — a checkbox the
 * browser requires and this handler checks again — and the approval `POST` is rate-limited per
 * client like the start and poll routes.
 *
 * A refusal answers the HTML page only to a browser (`Accept: text/html`); any other caller gets
 * the standard error envelope, like every other `/api/**` route.
 */
import { CLI_DEVICE_CODE_TTL_SECONDS } from '@indx-workspace/contracts/cli-auth';

import { checkRequestOrigin } from '../auth/origin';
import type { Principal } from '../rbac/principal';
import { currentRbacRuntime } from '../rbac/runtime';
import { currentWorkspacesRuntime } from '../workspaces/runtime';
import { displayUserCode, normaliseUserCode } from './device-code';
import { refuseOverLimit } from './handlers';
import { currentCliAuthRuntime } from './runtime';

const MAX_FORM_BYTES = 4 * 1024;

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Headers for every server-rendered auth form page (this one and `/api/auth/workspace`). */
export const PAGE_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  // The approval form must never be framed by another origin (clickjacking).
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
} as const;

function page(
  status: number,
  title: string,
  bodyHtml: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      ...extraHeaders,
      'content-type': 'text/html; charset=utf-8',
      ...PAGE_SECURITY_HEADERS,
    },
  });
}

/** Whether the caller is a browser asking for a page (a navigation or a form post). */
function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

/**
 * A refusal: the HTML page a browser navigation asked for, or — for any other caller — the
 * standard `{ error: { code, message, detail } }` envelope every `/api/**` route answers (#358),
 * with the same security headers.
 */
function refusal(
  request: Request,
  status: number,
  code: string,
  title: string,
  bodyHtml: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  if (acceptsHtml(request)) return page(status, title, bodyHtml, extraHeaders);
  return new Response(JSON.stringify({ error: { code, message: title, detail: title } }), {
    status,
    headers: {
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
      ...PAGE_SECURITY_HEADERS,
    },
  });
}

async function sessionPrincipal(request: Request): Promise<Principal | null> {
  const rbac = currentRbacRuntime();
  if (rbac === null) return null;
  const principal = await rbac.identify(request);
  return principal?.via === 'session' ? principal : null;
}

async function workspaceName(principal: Principal): Promise<string> {
  const workspaces = currentWorkspacesRuntime();
  if (workspaces === null || principal.userId === null) return principal.workspaceId;
  const view = await workspaces.repository.getForMember(principal.workspaceId, principal.userId);
  return view?.name ?? principal.workspaceId;
}

const signInFirst = (request: Request): Response =>
  refusal(
    request,
    401,
    'unauthenticated',
    'Sign in to approve the CLI',
    '<p>Sign in to Agent Workspace in this browser, then open this link again.</p>' +
      '<p><a href="/signin">Sign in</a></p>',
  );

/** `GET /api/auth/cli-verify?code=…` — the approval form. */
export async function renderVerifyPage(request: Request): Promise<Response> {
  if (currentCliAuthRuntime() === null) {
    return refusal(
      request,
      503,
      'cli_auth_not_configured',
      'CLI sign-in is unavailable',
      '<p>It is not configured here.</p>',
    );
  }
  const principal = await sessionPrincipal(request);
  if (principal === null) return signInFirst(request);
  const code = normaliseUserCode(new URL(request.url).searchParams.get('code'));
  const workspace = escapeHtml(await workspaceName(principal));
  const value = code === null ? '' : displayUserCode(code);
  return page(
    200,
    'Sign in the aw CLI',
    `<p>Approve only a code that <code>aw login</code> printed in your own terminal just now. ` +
      `The CLI will act as you (${escapeHtml(principal.actor)}) in <strong>${workspace}</strong> ` +
      `until you run <code>aw logout</code> or the sign-in expires.</p>` +
      `<form method="post" action="/api/auth/cli-verify">` +
      `<p><label>Code <input name="userCode" value="${value}" autocomplete="off" required ` +
      `pattern="[A-Za-z]{4}-?[A-Za-z]{4}"></label></p>` +
      `<p><label><input type="checkbox" name="confirm" value="yes" required> ` +
      `This is the code <code>aw login</code> printed in my own terminal just now.</label></p>` +
      `<button type="submit" name="decision" value="approve">Approve</button> ` +
      `<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form>`,
  );
}

async function readForm(request: Request): Promise<{
  readonly userCode: unknown;
  readonly decision: unknown;
  readonly confirm: unknown;
} | null> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return null;
  const form = new URLSearchParams(text);
  return {
    userCode: form.get('userCode'),
    decision: form.get('decision'),
    confirm: form.get('confirm'),
  };
}

/** `POST /api/auth/cli-verify` — record the person's answer to a user code. */
export async function submitVerifyPage(
  request: Request,
  nowMs: number = Date.now(),
): Promise<Response> {
  const runtime = currentCliAuthRuntime();
  if (runtime === null) {
    return refusal(
      request,
      503,
      'cli_auth_not_configured',
      'CLI sign-in is unavailable',
      '<p>It is not configured here.</p>',
    );
  }
  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: new URL(request.url).host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    return refusal(
      request,
      403,
      'cross_origin',
      'Refused',
      '<p>This form must be sent from this site.</p>',
    );
  }
  const limited = refuseOverLimit('approve', request, nowMs);
  if (limited !== null) {
    return refusal(
      request,
      429,
      'rate_limited',
      'Too many attempts',
      '<p>Wait a minute, then try again.</p>',
      limited.headers,
    );
  }
  const principal = await sessionPrincipal(request);
  if (principal === null || principal.userId === null) return signInFirst(request);
  const form = await readForm(request);
  const code = normaliseUserCode(form?.userCode);
  const decision = form?.decision;
  if (code === null || (decision !== 'approve' && decision !== 'deny')) {
    return refusal(
      request,
      400,
      'invalid_user_code',
      'That code is not valid',
      '<p>Check the code in your terminal and try again.</p>',
    );
  }
  if (decision === 'approve' && form?.confirm !== 'yes') {
    return refusal(
      request,
      400,
      'confirmation_required',
      'Confirm the code first',
      '<p>Approve only after confirming the code is the one your own terminal printed.</p>',
    );
  }
  const recorded = await runtime.sessions.recordApproval({
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    userCode: code,
    decision: decision === 'approve' ? 'approved' : 'denied',
    approvalExpiresAt: new Date(nowMs + CLI_DEVICE_CODE_TTL_SECONDS * 1000),
  });
  if (recorded === 'code-taken') {
    return refusal(
      request,
      409,
      'user_code_taken',
      'That code was already used',
      '<p>Run <code>aw login</code> again.</p>',
    );
  }
  return decision === 'approve'
    ? page(200, 'The CLI is signed in', '<p>Return to your terminal. You can close this page.</p>')
    : page(200, 'Sign-in denied', '<p>The CLI was not signed in.</p>');
}
