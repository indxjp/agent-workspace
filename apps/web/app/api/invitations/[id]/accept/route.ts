/**
 * `POST /api/invitations/:id/accept` — redeem a token using the pre-membership OIDC proof.
 *
 * The proxy exempts only this exact method/path because a new invitee has no tenant session yet.
 * This handler therefore owns the full boundary: same-origin, deployment secret, a valid dedicated
 * invitation-identity cookie, and the absence of an active tenant session. The cookie carries no
 * workspace or role; the invitation transaction establishes both.
 */
import { NextResponse } from 'next/server';

import {
  invitationIdentityCookieName,
  sessionCookieName,
  checkRequestOrigin,
  clearedInvitationIdentityCookie,
  mintSessionToken,
  newSessionClaims,
  readSessionSecret,
  sessionCookie,
  verifyInvitationIdentityToken,
  verifySessionToken,
} from '../../../../../server/auth';
import { cookieValue } from '../../../../../server/auth/cookies';
import {
  acceptInvitation,
  type AcceptInvitationResult,
} from '../../../../../server/invitations/handlers';
import { currentInvitationsRuntime } from '../../../../../server/invitations/runtime';
import { problem, readIdParam, readJsonBody } from '../../../../../server/rbac/http';
import { currentRbacRuntime } from '../../../../../server/rbac/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function responseFor(result: AcceptInvitationResult): NextResponse {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** `POST /api/invitations/:id/accept` — the invitee redeems their token. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const origin = checkRequestOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    requestHost: new URL(request.url).host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (!origin.ok) {
    return responseFor(
      problem(403, 'cross_origin', 'This write must come from the application origin.'),
    );
  }

  const secret = readSessionSecret(process.env);
  if (!secret.ok) {
    return responseFor(
      problem(503, 'server_not_configured', 'Invitation identity verification is unavailable.'),
    );
  }

  const cookieHeader = request.headers.get('cookie');
  const tenantSession = cookieValue(cookieHeader, sessionCookieName());
  if (tenantSession !== undefined) {
    const verifiedSession = await verifySessionToken(tenantSession, secret.secret);
    if (verifiedSession.ok) {
      // A workspace-B session is not proof that this caller may name workspace A. Refuse before
      // reading the id/token so a real and a nonexistent invitation remain byte-identical.
      return responseFor(
        problem(404, 'invitation_not_valid', 'This invitation link is not valid.'),
      );
    }
  }

  const identity = await verifyInvitationIdentityToken(
    cookieValue(cookieHeader, invitationIdentityCookieName()),
    secret.secret,
  );
  if (!identity.ok) {
    return responseFor(
      problem(
        401,
        'invitation_identity_required',
        'Complete the identity-provider sign-in before accepting an invitation.',
      ),
    );
  }

  const rbac = currentRbacRuntime();
  const invitations = currentInvitationsRuntime();
  if (rbac === null || invitations === null) {
    return responseFor(
      problem(
        503,
        'invitations_runtime_not_configured',
        'The invitation directory or audit sink is not wired into this deployment.',
      ),
    );
  }
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  if (!body.ok) return responseFor(body.result);
  const result = await acceptInvitation(
    rbac.directory,
    identity.claims,
    id,
    body.value,
    invitations,
  );
  const response = responseFor(result);
  if (result.acceptedSession !== undefined) {
    const session = await mintSessionToken(
      newSessionClaims(result.acceptedSession.email, result.acceptedSession.workspaceSlug),
      secret.secret,
    );
    response.cookies.set(sessionCookie(session));
  }
  if (result.clearInvitationIdentity === true) {
    response.cookies.set(clearedInvitationIdentityCookie());
  }
  return response;
}
