/**
 * "May the person looking at the team screen list, send, resend or revoke an invitation — and which
 * roles may they invite to?" — answered on the server, by the same `decide()` table and the same
 * `conferRole` comparison the four invitation routes themselves consult (issue #186).
 *
 * #186 repeats #185's prohibition: *"hide unauthorized controls while retaining server-side refusal
 * as the security boundary"*, and *"Builder and Viewer users cannot see or invoke invitation
 * controls"*. Hiding a control needs an answer **before** it is rendered, so the answer is computed
 * where the policy lives and handed across as a prop from `app/(shell)/admin/users/page.tsx`.
 * `./membership-capability.ts` is the precedent this follows; the differences are the four routes
 * and the reason the two capabilities stay separate contracts.
 *
 * ## Why the ownership answers are the routes' own
 *
 * `GET`/`POST /api/invitations` pass `not-applicable` (`app/api/invitations/route.ts`), and
 * `POST /api/invitations/:id/resend` and `DELETE /api/invitations/:id` pass `unknown` — the handler
 * has not read the row yet, and their own headers say so. Those exact values are what this asks
 * `decide()`, so the screen's answer and the route's answer are the same cell of the matrix rather
 * than two readings of it. `unknown` denies for every grant narrower than `any`, which is why Owner
 * and Admin — whose grant over `invitations` is `any` (§21's `MANAGE`, `rbac/permissions.ts`) — are
 * admitted and Builder and Viewer, who have no entry at all, are not.
 *
 * `resend` is a declared sub-resource of `invitations` (`rbac/declarations/W9-TEAM-121.ts`), so
 * `decide()` answers it at the parent's width; asking it separately is what proves that, rather than
 * assuming it.
 *
 * ## Why conferral is asked rather than tabulated
 *
 * `POST /api/invitations` routes the requested role through `readConferredRole` → `conferRole`
 * exactly as `PATCH /api/memberships/:id` does (`server/invitations/handlers.ts`). §21 is **not** a
 * privilege ladder, so the set of roles an Admin may invite is `['admin','viewer']` and cannot be
 * derived from any ordering. A role `<select>` built from anything but `conferRole` would offer
 * options the route answers `403` to.
 *
 * ## Why not a probe
 *
 * The only probe available is `POST /api/invitations` itself, which creates a durable row, mints a
 * token and writes an audit event. `./membership-capability.ts` rejected a probe for a weaker
 * reason than that.
 *
 * ## Unresolvable means refused
 *
 * Every input `./team-viewer.ts` cannot settle — no RBAC runtime, no session, no user row, no
 * membership in the session's workspace, a role the table does not recognise — answers
 * `NO_INVITATION_CAPABILITY` (ADR-0015).
 */
import { NO_INVITATION_CAPABILITY, type InvitationCapability } from '../../contracts/invitations';
import { decide, type Ownership } from '../rbac/decide';
import { parseRole } from '../rbac/roles';
import { conferrableRolesFor } from './membership-capability';
import type { TeamViewer } from './team-viewer';

/** The four route questions the invitations section's controls depend on. */
export interface InvitationGrants {
  readonly canListInvitations: boolean;
  readonly canCreateInvitation: boolean;
  readonly canResendInvitation: boolean;
  readonly canRevokeInvitation: boolean;
}

const NO_GRANTS: InvitationGrants = {
  canListInvitations: false,
  canCreateInvitation: false,
  canResendInvitation: false,
  canRevokeInvitation: false,
};

/**
 * Ask `decide()` the four invitation routes, with the ownership each route actually passes.
 *
 * Exported so the matrix test can drive every role without a session or a database.
 */
export function invitationGrantsForRole(role: string): InvitationGrants {
  const parsed = parseRole(role);
  if (parsed === null) return NO_GRANTS;
  // `decide()` reads the specification's path notation, not Next.js's `[id]` folder spelling.
  // A page-render capability probe, never a real bearer credential: this screen is reached by a
  // session cookie, and a browser token's scope grammar has no cell over `invitations` at all.
  const ask = (method: string, path: string, ownership: Ownership): boolean =>
    decide({ role: parsed, method, path, ownership, scope: null }).effect === 'allow';
  return {
    canListInvitations: ask('GET', '/api/invitations', 'not-applicable'),
    canCreateInvitation: ask('POST', '/api/invitations', 'not-applicable'),
    canResendInvitation: ask('POST', '/api/invitations/:id/resend', 'unknown'),
    canRevokeInvitation: ask('DELETE', '/api/invitations/:id', 'unknown'),
  };
}

/**
 * The capability for a resolved viewer, or the all-deny answer for one who could not be resolved.
 *
 * The invitable set is `conferrableRolesFor` — `./membership-capability.ts`'s own reading of
 * `conferRole` — rather than a second copy of the same loop: `POST /api/invitations` and
 * `PATCH /api/memberships/:id` route their requested role through the identical comparison, so two
 * readings of it could only ever disagree by being wrong.
 */
export function invitationCapabilityForViewer(viewer: TeamViewer | null): InvitationCapability {
  if (viewer === null) return NO_INVITATION_CAPABILITY;
  return {
    ...invitationGrantsForRole(viewer.role),
    invitableRoles: conferrableRolesFor(viewer.role),
  };
}
