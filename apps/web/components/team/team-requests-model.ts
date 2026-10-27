import {
  ApiProblemError,
  ContractViolationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';

import type {
  CreateInvitationInput,
  IssuedInvitationResponse,
} from '@indx-workspace/contracts/invitations';
import { requestOutcome } from '../../lib/request-outcome';
import {
  revealIssuedInvitation,
  type InvitationResource,
  type RevealedInvitation,
} from './invitations-model';
import {
  removalImpactFromReads,
  type MembershipResource,
  type MembershipRoleName,
  type RemovalImpactCounts,
  type RequestProblem,
} from './model';

/**
 * The team screens' calls through the SDK client. Each resolves with what the screen shows: a
 * value, or the {@link RequestProblem} (and the HTTP `status`, `null` when the server never
 * answered) the screen words for a refused or unanswered request.
 */
export type RequestOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: RequestProblem; readonly status: number | null };

export const UNREADABLE_MEMBERS =
  'The member list came back in a shape this screen cannot read, so nothing is shown ' +
  'rather than a partial list. Reload to try again.';

export const UNREADABLE_INVITATIONS =
  'The invitation list came back in a shape this screen cannot read, so nothing is shown rather ' +
  'than a partial list. Reload to try again.';

/**
 * The shared outcome plus the HTTP status of a refusal: `describeMembershipFailure` needs it for
 * the unenveloped 500, which the shared problem words as transport and so no longer carries it.
 */
async function outcome<T>(request: Promise<T>, unreadable: string): Promise<RequestOutcome<T>> {
  let status: number | null = null;
  const result = await requestOutcome(
    request.catch((error: unknown) => {
      if (error instanceof ApiProblemError) status = error.status;
      throw error;
    }),
    'The request failed before the server could answer',
    unreadable,
  );
  return result.ok ? result : { ...result, status };
}

/** `GET /api/memberships`. */
export function loadMembers(
  client: AgentWorkspaceClient,
): Promise<RequestOutcome<readonly MembershipResource[]>> {
  return outcome(client.team.members.list(), UNREADABLE_MEMBERS);
}

/** `PATCH /api/memberships/:id`. */
export function changeMemberRole(
  client: AgentWorkspaceClient,
  membershipId: string,
  role: MembershipRoleName,
): Promise<RequestOutcome<MembershipResource>> {
  return outcome(client.team.members.setRole(membershipId, role), UNREADABLE_MEMBERS);
}

/** `DELETE /api/memberships/:id`. */
export async function removeMember(
  client: AgentWorkspaceClient,
  membershipId: string,
): Promise<RequestOutcome<null>> {
  return outcome(
    client.team.members.remove(membershipId).then(() => null),
    UNREADABLE_MEMBERS,
  );
}

/**
 * How many sessions and projects this member owns, or `null` when either read fails: a failed
 * read is not a zero. Sessions are read through `listAll`, which follows any cursor the server returns.
 */
export async function countRemovalImpact(
  client: AgentWorkspaceClient,
  userId: string,
): Promise<RemovalImpactCounts | null> {
  const sessions = (async () => {
    let total = 0;
    for await (const session of client.sessions.listAll()) {
      if (session.userId === userId) total += 1;
    }
    return total;
  })().catch(() => null);
  const projects = client.projects
    .list({ archived: 'all' })
    .then((rows) => rows.filter((project) => project.createdBy === userId).length)
    .catch(() => null);
  return removalImpactFromReads(...(await Promise.all([sessions, projects])));
}

/** `GET /api/invitations`. */
export function loadInvitations(
  client: AgentWorkspaceClient,
): Promise<RequestOutcome<readonly InvitationResource[]>> {
  return outcome(client.team.invitations.list(), UNREADABLE_INVITATIONS);
}

/**
 * Turn the one response that carries a token into the reveal. `null` is an answer that succeeded
 * but could not be read; nothing of it is quoted, because it has the token in it somewhere.
 */
function reveal(
  issued: Promise<IssuedInvitationResponse>,
  origin: string,
): Promise<RequestOutcome<RevealedInvitation | null>> {
  return outcome(
    issued
      .then((response) => revealIssuedInvitation(response, origin))
      .catch((error: unknown) => {
        if (error instanceof ContractViolationError) return null;
        throw error;
      }),
    '',
  );
}

/** `POST /api/invitations`. */
export function issueInvitation(
  client: AgentWorkspaceClient,
  input: CreateInvitationInput,
  origin: string,
): Promise<RequestOutcome<RevealedInvitation | null>> {
  return reveal(client.team.invitations.create(input), origin);
}

/** `POST /api/invitations/:id/resend`. */
export function resendInvitation(
  client: AgentWorkspaceClient,
  invitationId: string,
  origin: string,
): Promise<RequestOutcome<RevealedInvitation | null>> {
  return reveal(client.team.invitations.resend(invitationId), origin);
}

/** `DELETE /api/invitations/:id`. */
export function revokeInvitation(
  client: AgentWorkspaceClient,
  invitationId: string,
): Promise<RequestOutcome<InvitationResource>> {
  return outcome(client.team.invitations.revoke(invitationId), UNREADABLE_INVITATIONS);
}
