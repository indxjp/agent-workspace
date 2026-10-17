/**
 * The invitation wire contract lives in `@indx-workspace/contracts/invitations`; this module
 * re-exports it as the application's import seam (see `./agents.ts`). What stays here is the one
 * value that is not a wire contract: the server-to-component capability prop below.
 */
export {
  InvitationListResponseSchema,
  InvitationResourceSchema,
  IssuedInvitationResponseSchema,
  type InvitationResource,
} from '@indx-workspace/contracts/invitations';

import type { MembershipRoleName } from '@indx-workspace/contracts/team';

/**
 * What the signed-in caller may do to this workspace's invitations, answered by the server's own
 * decision table and handed to the browser as a prop (issue #186).
 *
 * It sits beside {@link import('./team').MembershipCapability} and deliberately apart from it: the
 * two describe different resources with different §21 grants, and one contract answering for both
 * would let a change to `memberships` silently move an invitation control.
 * `apps/web/server/team/invitation-capability.ts` produces it by asking the same `decide()` cells
 * the four invitation routes pass; `apps/web/components/team/**` consumes it.
 *
 * {@link InvitationCapability.invitableRoles} is the set `conferRole` answers `allow` for against
 * this caller's own role — the same grant `POST /api/invitations` routes the requested role through.
 * It is a grant, not a ladder: §21 does not order the four roles, so the list cannot be
 * reconstructed in the browser from a role name.
 *
 * Every field is `false`/empty when the session, the RBAC runtime, the user row or the membership
 * could not be resolved, because an undecidable check denies (ADR-0015).
 */
export interface InvitationCapability {
  readonly canListInvitations: boolean;
  readonly canCreateInvitation: boolean;
  readonly canResendInvitation: boolean;
  readonly canRevokeInvitation: boolean;
  readonly invitableRoles: readonly MembershipRoleName[];
}

/** The answer for a caller nothing could be established about. Every field denies. */
export const NO_INVITATION_CAPABILITY: InvitationCapability = {
  canListInvitations: false,
  canCreateInvitation: false,
  canResendInvitation: false,
  canRevokeInvitation: false,
  invitableRoles: [],
};
