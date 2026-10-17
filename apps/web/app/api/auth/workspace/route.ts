/**
 * `/api/auth/workspace` — the minimal post-callback selection step, and the endpoint that mints
 * or switches the tenant session after re-reading membership. Issue #118.
 *
 * `GET` renders the selection step: whatever CURRENT memberships the selection cookie's user
 * holds, each a plain HTML form posting back to `POST` on this same route. It is deliberately not
 * a `page.tsx` — no `ui/*.html` mockup names a workspace directory or switcher screen yet (`#120`
 * builds that, on top of `#119`'s directory API, neither of which this task has), and a `route.ts`
 * that returns HTML is not a page `tests/screen-inventory.test.ts` has any claim over: it is
 * `apps/web/app` scanned by `tests/route-inventory.test.ts`'s rules, not `filterPageFiles`'s. `GET`
 * needs no origin check — it is a safe method and changes nothing.
 *
 * `POST` is reached in two shapes:
 *
 *   * **Post-callback selection.** The caller has no tenant session yet, only the short-lived
 *     selection cookie `apps/web/app/api/auth/callback/route.ts` minted when an identity resolved
 *     to more than one CURRENT membership. The `GET` page above posts here as a plain form, so the
 *     body is read as form data and never as JSON.
 *   * **Switching.** The caller already carries a valid tenant session and wants a different one
 *     of their memberships. `#120` builds the switcher UI in a later wave; this is what it will
 *     call.
 *
 * Both shapes re-read `directory.membershipsForUser` **at this request**, never trusting a list
 * captured earlier — the callback's list, the `GET` page's list and the selection cookie's
 * identity are all stale the instant a membership changes, and this is the one place that is
 * allowed to matter.
 *
 * Both methods are exempted from `apps/web/proxy.ts`'s default `/api/**` session gate, the same
 * way `/api/setup` is: reaching them with no tenant session is the whole point. Exemption from
 * that gate is also exemption from its `checkRequestOrigin` call, so — like `signInAction` in
 * `apps/web/app/signin/actions.ts`, which is in the same position for the same reason — `POST`
 * makes that call itself.
 *
 * Issue #236 (SDK-04, S-2) adds a third shape, on the same route rather than a new one: a caller
 * that already carries a valid tenant session sends `Content-Type: application/json` instead of a
 * form, and gets back `200 { workspace }` with the new `Set-Cookie` instead of a `303`. The branch
 * is on content type alone — every other fact this route already establishes (origin, the session
 * or the selection cookie, the re-read membership) is shared code, not a parallel copy of it — and
 * every failure in that branch is the standard `{ error: { code, message } }` envelope, never the
 * form path's bare `{ error: '<code>' }`. The form path is unchanged, byte for byte, for one
 * release (spec §3.2 of `docs/sdk/04-api-specification.md`, playbook §3).
 */
import { NextResponse } from 'next/server';

import { WorkspaceSwitchRequestSchema } from '@indx-workspace/contracts/workspaces';

import {
  sessionCookieName,
  selectionCookieName,
  checkRequestOrigin,
  clearedSelectionCookie,
  mintSessionToken,
  newSessionClaims,
  readSessionSecret,
  safeNextPath,
  sessionCookie,
  verifySelectionToken,
  verifySessionToken,
  type SelectionVerifyResult,
} from '../../../../server/auth';
import { cookieValue } from '../../../../server/auth/cookies';
import { pickerQuery, selectionPageHtml } from '../../../../server/auth/workspace-picker';
import { PAGE_SECURITY_HEADERS } from '../../../../server/cli-auth/verify-page';
import { currentRbacRuntime } from '../../../../server/rbac/runtime';
import { getWorkspace } from '../../../../server/workspaces/handlers';
import { currentWorkspacesRuntime } from '../../../../server/workspaces/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every redirect this route issues is to a path on the origin the caller already reached, so the
 * `Location` is that path and nothing else. A relative reference is valid per RFC 9110 §10.2.2 and
 * every browser resolves it against the request URL, which is the only origin that can be right.
 *
 * An absolute URL cannot be: `NextResponse.redirect` needs one, and the only origin available to
 * build it from is `request.url` — the address this server is *bound to*, not the address the
 * client used. They differ whenever a reverse proxy, a container port map or a host alias sits in
 * between, and the redirect then crosses origins: the session cookie set for the caller's host is
 * not sent to the server's, so a freshly minted session arrives signed-out. The `Host` and
 * `X-Forwarded-Host` headers would name the caller's origin, but they are caller-supplied, and an
 * open redirect is a worse defect than the one it fixes. A relative `Location` needs no origin at
 * all.
 */
function redirectTo(pathname: string, query = ''): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: `${pathname}${query}` } });
}

async function readSelection(request: Request, secret: string): Promise<SelectionVerifyResult> {
  const token = cookieValue(request.headers.get('cookie'), selectionCookieName());
  return verifySelectionToken(token, secret);
}

export async function GET(request: Request): Promise<Response> {
  const secret = readSessionSecret(process.env);
  if (!secret.ok) return NextResponse.json({ error: 'server_not_configured' }, { status: 503 });

  const selection = await readSelection(request, secret.secret);
  if (!selection.ok) return redirectTo('/signin', '?error=session_expired');

  const runtime = currentRbacRuntime();
  const memberships =
    runtime === null ? [] : await runtime.directory.membershipsForUser(selection.claims.userId);
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const destination = safeNextPath(url.searchParams.get('next'));

  return new NextResponse(
    selectionPageHtml(selection.claims.email, memberships, error, destination),
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS },
    },
  );
}

/**
 * `{ error: { code, message, detail } }` — the standard envelope, for the JSON branch only.
 * `detail` duplicates `message` until the next major release (ADR-0078 D7); the workspace switcher still reads it.
 */
function jsonProblem(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message, detail: message } }, { status });
}

function contentTypeIsJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  return (
    header !== null && (header.split(';')[0] ?? '').trim().toLowerCase() === 'application/json'
  );
}

export async function POST(request: Request): Promise<Response> {
  const isJson = contentTypeIsJson(request);

  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: new URL(request.url).host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    console.warn(`[auth] cross-origin workspace selection refused: ${origin.reason}`);
    return isJson
      ? jsonProblem(403, 'cross_origin', 'Cross-origin workspace switch requests are refused.')
      : NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  }

  const secret = readSessionSecret(process.env);
  const runtime = currentRbacRuntime();
  if (!secret.ok || runtime === null) {
    return isJson
      ? jsonProblem(503, 'server_not_configured', 'The workspace switch is not configured.')
      : NextResponse.json({ error: 'server_not_configured' }, { status: 503 });
  }

  let requested: string;
  // Only the form branch redirects, so only it reads `next`; the guard runs on every read.
  let destination: string | null = null;
  if (isJson) {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return jsonProblem(400, 'malformed_request', 'The request body is not valid JSON.');
    }
    const parsed = WorkspaceSwitchRequestSchema.safeParse(json);
    if (!parsed.success) {
      return jsonProblem(
        400,
        'malformed_request',
        'The request body must be { workspace: string }.',
      );
    }
    requested = parsed.data.workspace;
  } else {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: 'malformed_request' }, { status: 400 });
    }
    const raw = form.get('workspace');
    if (typeof raw !== 'string' || raw.length === 0) {
      return NextResponse.json({ error: 'malformed_request' }, { status: 400 });
    }
    requested = raw;
    destination = safeNextPath(form.get('next'));
  }

  const cookieHeader = request.headers.get('cookie');
  const sessionToken = cookieValue(cookieHeader, sessionCookieName());
  const verifiedSession =
    sessionToken === undefined ? null : await verifySessionToken(sessionToken, secret.secret);

  let email: string;
  let userId: string | null = null;
  if (verifiedSession !== null && verifiedSession.ok) {
    email = verifiedSession.claims.sub;
  } else {
    const selection = await readSelection(request, secret.secret);
    if (!selection.ok) {
      return isJson
        ? jsonProblem(401, 'session_expired', 'Sign in again to select a workspace.')
        : redirectTo('/signin', '?error=session_expired');
    }
    email = selection.claims.email;
    userId = selection.claims.userId;
  }

  if (userId === null) {
    const user = await runtime.directory.findUserByEmail(email);
    if (user === null) {
      return isJson
        ? jsonProblem(404, 'workspace_not_available', 'That is not one of your current workspaces.')
        : redirectTo('/api/auth/workspace', pickerQuery('workspace_not_available', destination));
    }
    userId = user.id;
  }

  // Re-read now, never from a list captured at callback time, at GET-page render time, or
  // earlier in this request's own session: a membership removed since is a membership this
  // request must not honour.
  const memberships = await runtime.directory.membershipsForUser(userId);
  const match = memberships.find(
    (candidate) => candidate.workspaceId === requested || candidate.workspaceSlug === requested,
  );
  if (match === undefined) {
    // Identical outcome whether `requested` names a real workspace this user does not belong to,
    // or names nothing at all — the response must not be an oracle for which.
    return isJson
      ? jsonProblem(404, 'workspace_not_available', 'That is not one of your current workspaces.')
      : redirectTo('/api/auth/workspace', pickerQuery('workspace_not_available', destination));
  }

  const token = await mintSessionToken(newSessionClaims(email, match.workspaceSlug), secret.secret);

  if (isJson) {
    const workspacesRuntime = currentWorkspacesRuntime();
    if (workspacesRuntime === null) {
      return jsonProblem(503, 'server_not_configured', 'The workspace switch is not configured.');
    }
    // The same read `GET /api/workspaces/:id` performs, re-run for the workspace just selected —
    // one projection, so the switch's body and a follow-up `GET` can never disagree about it.
    const result = await getWorkspace(workspacesRuntime.repository, match.workspaceId, userId);
    if (result.status !== 200) {
      return jsonProblem(
        404,
        'workspace_not_available',
        'That is not one of your current workspaces.',
      );
    }
    const response = NextResponse.json(result.body, { status: 200 });
    response.cookies.set(sessionCookie(token));
    response.cookies.set(clearedSelectionCookie());
    return response;
  }

  const response = redirectTo(destination ?? '/');
  // Two independent cookies, so two `.set()` calls: `NextResponse.cookies.set` appends a
  // `Set-Cookie` header per call rather than overwriting the previous one.
  response.cookies.set(sessionCookie(token));
  response.cookies.set(clearedSelectionCookie());
  return response;
}
