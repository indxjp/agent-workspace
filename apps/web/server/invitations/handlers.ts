/**
 * The handlers behind `/api/invitations` — issue #121's secure workspace invitation and
 * acceptance lifecycle.
 *
 * Framework-free, the same shape `apps/web/server/rbac/handlers.ts` uses and for the same reason:
 * every one of these takes plain data plus the ports it needs and returns an
 * {@link ApiResult}, so a test drives it without a `Request`, and `apps/web/app/api/invitations/**`
 * is the thin wiring above it that `routes.test.ts`-style suites exercise separately.
 *
 * ## API-key callers are refused on every one of these, uniformly
 *
 * `apps/web/proxy.ts`'s Bearer-key exemption list is fixed to `/api/users`, `/api/memberships` and
 * `/api/api-keys` and does not name `/api/invitations`, so a real deployment never routes a bearer
 * key here at all. Every handler below checks
 * `principal.via === 'api-key'` anyway, for the reason `docs/adr/W9-WS-119-api-key-callers-are-
 * refused.md` gives for the same shape on `/api/workspaces`: an API key represents no person, an
 * invitation both invites and is redeemed by one, and a security boundary this task can prove
 * inside its own `Owns` should not rest solely on a list it cannot see change.
 *
 * ## The token is never audited, and never logged
 *
 * Every `subjectLabel`/`actorLabel` this file builds is composed from an email and a role — never
 * from `outcome.token` or `outcome.invitation` (which, per `directory.ts`'s own types, has nowhere
 * to put one). `console` is never called here at all, which is the other half of "never logged".
 */
import type { DirectoryRoot, WorkspaceDirectory } from '../rbac/directory';
import type { InvitationIdentityClaims } from '../auth/invitation-identity';
import { asObject, readConferredRole, readEmail, readString } from '../rbac/handlers';
import type { ApiResult } from '../http/result';
import { problemWithDetail as problem } from '../http/result';
import { resolveSessionActorUserId } from '../rbac/ownership';
import type { Principal } from '../rbac/principal';
import type { InvitationsRuntime } from './runtime';

const INVITATION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function requireExactFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): ApiResult | null {
  const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
  return unknownField === undefined
    ? null
    : problem(400, 'invalid_field', `"${unknownField}" is not accepted by this request.`);
}

function readInvitationId(
  id: unknown,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: ApiResult } {
  if (typeof id !== 'string' || !INVITATION_ID_SHAPE.test(id)) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_field',
        'The invitation id in the path must be a canonical UUID.',
      ),
    };
  }
  return { ok: true, value: id };
}

function noSuchInvitation(): ApiResult {
  return problem(404, 'no_such_invitation', 'No invitation exists in this workspace.');
}

/** `403`, uniformly, before any of these handlers reads a body or a row. See this file's header. */
function refuseApiKey(): ApiResult {
  return problem(
    403,
    'api_key_not_permitted',
    'An API key represents no person. Invitations are sent and redeemed by people; mint a ' +
      'session for the request instead.',
  );
}

/**
 * Resolve the human behind a session immediately before a lifecycle write.
 *
 * `authorise()` proved a current membership while building the principal, but that membership can
 * disappear before this handler reads the directory. Invitation writes need a real `users.id` for
 * `invited_by` and the audit actor. Falling back to the oldest Owner would stamp a different person
 * and repeat the identity-substitution defect found in W9-WS-119, so the vanished-membership state
 * is undecidable and no write is attempted.
 */
async function resolveHumanActor(
  directory: WorkspaceDirectory,
  principal: Principal,
): Promise<
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly result: ApiResult }
> {
  const userId = resolveSessionActorUserId(await directory.listMemberships(), principal.actor);
  return userId === null
    ? {
        ok: false,
        result: problem(
          500,
          'authorisation_undecidable',
          'The authenticated session no longer resolves to a current workspace member. No invitation change was made.',
        ),
      }
    : { ok: true, userId };
}

// ── create / list ───────────────────────────────────────────────────────────────────────────

/** `GET /api/invitations` — every invitation this workspace has ever sent, newest first. */
export async function listInvitations(
  directory: WorkspaceDirectory,
  principal: Principal,
): Promise<ApiResult> {
  if (principal.via === 'api-key') return refuseApiKey();
  return { status: 200, body: { invitations: await directory.listInvitations() } };
}

/** `POST /api/invitations` — invite an address to one of §21's four roles this caller may confer. */
export async function createInvitation(
  directory: WorkspaceDirectory,
  principal: Principal,
  body: unknown,
  runtime: InvitationsRuntime,
): Promise<ApiResult> {
  if (principal.via === 'api-key') return refuseApiKey();
  const object = asObject(body);
  if (!object.ok) return object.result;
  const exactFields = requireExactFields(object.body, ['email', 'role']);
  if (exactFields !== null) return exactFields;
  const email = readEmail(object.body);
  if (!email.ok) return email.result;
  const role = readConferredRole(object.body, principal.role);
  if (!role.ok) return role.result;

  const actor = await resolveHumanActor(directory, principal);
  if (!actor.ok) return actor.result;
  const outcome = await directory.createInvitation({
    email: email.value,
    role: role.value,
    invitedBy: actor.userId,
  });
  switch (outcome.kind) {
    case 'created': {
      const sent = await runtime.sendInvitation.send({
        invitationId: outcome.invitation.id,
        email: outcome.invitation.email,
        token: outcome.token,
      });
      await runtime.recordAuditEvent({
        workspaceId: principal.workspaceId,
        actorPrincipalId: principal.principalId,
        actorUserId: actor.userId,
        actorLabel: principal.actor,
        action: 'invitation-created',
        subjectId: outcome.invitation.id,
        subjectLabel: `${outcome.invitation.email} invited as ${outcome.invitation.role}`,
      });
      return {
        status: 201,
        body: {
          invitation: outcome.invitation,
          // The one time. §22's own rule, applied here: this is the only response body in the
          // program that carries this invitation's plaintext token.
          token: outcome.token,
          link: sent.link,
          warning:
            'This is the only time this token is shown. Only its hash is stored; it cannot be ' +
            'recovered, only revoked and reissued by resending.',
        },
      };
    }
    case 'already-invited':
      return problem(
        409,
        'already_invited',
        `${outcome.email} already has a pending invitation to this workspace. Resend it, or ` +
          'revoke it before sending a new one.',
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled createInvitation outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── resend / revoke ─────────────────────────────────────────────────────────────────────────

/** `POST /api/invitations/:id/resend` — a fresh token and a fresh expiry for the same row. */
export async function resendInvitation(
  directory: WorkspaceDirectory,
  principal: Principal,
  id: unknown,
  runtime: InvitationsRuntime,
): Promise<ApiResult> {
  if (principal.via === 'api-key') return refuseApiKey();
  const invitationId = readInvitationId(id);
  if (!invitationId.ok) return invitationId.result;
  const actor = await resolveHumanActor(directory, principal);
  if (!actor.ok) return actor.result;
  const outcome = await directory.resendInvitation(invitationId.value);
  switch (outcome.kind) {
    case 'resent': {
      const sent = await runtime.sendInvitation.send({
        invitationId: outcome.invitation.id,
        email: outcome.invitation.email,
        token: outcome.token,
      });
      await runtime.recordAuditEvent({
        workspaceId: principal.workspaceId,
        actorPrincipalId: principal.principalId,
        actorUserId: actor.userId,
        actorLabel: principal.actor,
        action: 'invitation-resent',
        subjectId: outcome.invitation.id,
        subjectLabel: `${outcome.invitation.email} re-invited as ${outcome.invitation.role}`,
      });
      return {
        status: 200,
        body: {
          invitation: outcome.invitation,
          token: outcome.token,
          link: sent.link,
          warning: 'This is the only time this token is shown. The previous token no longer works.',
        },
      };
    }
    case 'no-such-invitation':
      return noSuchInvitation();
    case 'already-accepted':
      return problem(
        409,
        'already_accepted',
        `${outcome.invitation.email}'s invitation has already been accepted; there is nothing to resend.`,
      );
    case 'revoked':
      return problem(
        409,
        'invitation_revoked',
        `${outcome.invitation.email}'s invitation was revoked. Create a new one instead of resending it.`,
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled resendInvitation outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `DELETE /api/invitations/:id` — revoke. Revocation is a timestamp, not a delete (§36 audits it). */
export async function revokeInvitation(
  directory: WorkspaceDirectory,
  principal: Principal,
  id: unknown,
  runtime: InvitationsRuntime,
): Promise<ApiResult> {
  if (principal.via === 'api-key') return refuseApiKey();
  const invitationId = readInvitationId(id);
  if (!invitationId.ok) return invitationId.result;
  const actor = await resolveHumanActor(directory, principal);
  if (!actor.ok) return actor.result;
  const outcome = await directory.revokeInvitation(invitationId.value);
  switch (outcome.kind) {
    case 'revoked':
      await runtime.recordAuditEvent({
        workspaceId: principal.workspaceId,
        actorPrincipalId: principal.principalId,
        actorUserId: actor.userId,
        actorLabel: principal.actor,
        action: 'invitation-revoked',
        subjectId: outcome.invitation.id,
        subjectLabel: `${outcome.invitation.email}'s invitation revoked`,
      });
      return { status: 200, body: { invitation: outcome.invitation } };
    case 'already-revoked':
      // Idempotent, the same shape `DELETE /api/api-keys/:id` already answers with for a key
      // revoked twice: the caller asked for a state that already holds, not for an error.
      return { status: 200, body: { invitation: outcome.invitation } };
    case 'no-such-invitation':
      return noSuchInvitation();
    case 'already-accepted':
      return problem(
        409,
        'already_accepted',
        `${outcome.invitation.email}'s invitation has already been accepted; there is nothing to revoke.`,
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled revokeInvitation outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── accept ──────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/invitations/:id/accept` — redeem a token after the route verifies the dedicated OIDC
 * invitation-identity cookie. No workspace role participates in this decision.
 */
export interface AcceptInvitationResult extends ApiResult {
  /** Present only after the transaction created a membership and may be used to mint a session. */
  readonly acceptedSession?: { readonly email: string; readonly workspaceSlug: string };
  /** The one-purpose identity cookie is spent by accepted and already-member outcomes. */
  readonly clearInvitationIdentity?: true;
}

export async function acceptInvitation(
  directoryRoot: DirectoryRoot,
  identity: InvitationIdentityClaims,
  id: unknown,
  body: unknown,
  runtime: InvitationsRuntime,
): Promise<AcceptInvitationResult> {
  const invitationId = readInvitationId(id);
  if (!invitationId.ok) return invitationId.result;
  const object = asObject(body);
  if (!object.ok) return object.result;
  const exactFields = requireExactFields(object.body, ['token']);
  if (exactFields !== null) return exactFields;
  const token = readString(object.body, 'token', 4096);
  if (!token.ok) return token.result;

  const outcome = await directoryRoot.acceptInvitation(invitationId.value, token.value, identity);
  switch (outcome.kind) {
    case 'accepted':
      await runtime.recordAuditEvent({
        workspaceId: outcome.workspaceId,
        actorPrincipalId: outcome.membership.principalId,
        actorUserId: outcome.user.id,
        actorLabel: outcome.user.email,
        action: 'invitation-accepted',
        subjectId: outcome.membership.id,
        subjectLabel: `${outcome.user.email} joined as ${outcome.membership.role}`,
      });
      return {
        status: 200,
        body: { workspaceId: outcome.workspaceId, membership: outcome.membership },
        acceptedSession: { email: outcome.user.email, workspaceSlug: outcome.workspaceSlug },
        clearInvitationIdentity: true,
      };
    case 'already-member':
      await runtime.recordAuditEvent({
        workspaceId: outcome.workspaceId,
        actorPrincipalId: outcome.principalId,
        actorUserId: outcome.userId,
        actorLabel: identity.email,
        action: 'invitation-accepted',
        subjectId: invitationId.value,
        subjectLabel: `${identity.email} was already a member; the invitation was consumed`,
      });
      return {
        ...problem(
          409,
          'already_a_member',
          'You already belong to this workspace. The invitation has been consumed.',
        ),
        clearInvitationIdentity: true,
      };
    // `invalid` collapses "no such id", "wrong token" and "wrong email" into one answer — see
    // `packages/core/src/db/repositories/directory.ts`'s `AcceptInvitationOutcome` header.
    // Verifier attack 2: neither this response nor its status may differ from any other case
    // here in a way that reveals whether a matching invitation exists at all.
    case 'invalid':
      return problem(404, 'invitation_not_valid', 'This invitation link is not valid.');
    case 'expired':
      return problem(
        410,
        'invitation_expired',
        'This invitation has expired. Ask whoever invited you to resend it.',
      );
    case 'revoked':
      return problem(410, 'invitation_revoked', 'This invitation was revoked.');
    case 'already-accepted':
      return problem(409, 'invitation_already_used', 'This invitation has already been accepted.');
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled acceptInvitation outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
