/**
 * The membership wire contract lives in `@indx-workspace/contracts/team`; this module re-exports
 * it as the application's import seam (see `./agents.ts`). What stays here is the one value that is
 * not a wire contract: the server-to-component capability prop below.
 *
 * `team.test.ts` still asserts `MEMBERSHIP_ROLES` equals the server's `ROLES` both as a value and
 * as a type, so the package's copy of §21's roles and the RBAC decision table cannot drift.
 */
export {
  MEMBERSHIP_ROLES,
  MembershipListResponseSchema,
  MembershipResourceSchema,
  type MembershipResource,
  type MembershipRoleName,
} from '@indx-workspace/contracts/team';

import type { MembershipRoleName } from '@indx-workspace/contracts/team';

/**
 * What the signed-in caller may do on the team screen, answered by the server's own decision table
 * and handed to the browser as a prop (issue #185).
 *
 * It lives beside the wire contracts rather than in either half because it crosses the same
 * boundary `ProjectArchiveCapability` does (`./projects.ts`):
 * `apps/web/server/team/membership-capability.ts` produces it by asking the single `decide()` table
 * the membership routes themselves consult, and `apps/web/components/team/**` consumes it. Neither
 * side may import the other, and the value is serialised across the server/client component
 * boundary on its way over.
 *
 * The rule it encodes is the one #185 states as a prohibition — *"do not introduce a client-side
 * role policy table"*. **Grants come from the server; comparisons of row facts happen in the
 * browser.** The browser is left with exactly two comparisons, and neither names a role: is this
 * row the viewer's own (`userId === viewerUserId`), and is this row the workspace's only Owner
 * (counted over the list the server just returned).
 *
 * {@link MembershipCapability.conferrableRoles} is the set `conferRole` (`server/rbac/conferral.ts`)
 * answers `allow` for, evaluated against the viewer's own role. It is a **grant**, not a ladder:
 * §21 does not order the four roles, so the list cannot be reconstructed from `viewerUserId` or
 * from a role name in the client.
 *
 * Every field is `false`/empty/`null` when the session, the RBAC runtime, the user row or the
 * membership could not be resolved, because an undecidable check denies (ADR-0015).
 */
export interface MembershipCapability {
  readonly canListMembers: boolean;
  readonly canChangeRole: boolean;
  readonly canRemoveMember: boolean;
  readonly conferrableRoles: readonly MembershipRoleName[];
  readonly viewerUserId: string | null;
}

/** The answer for a caller nothing could be established about. Every field denies. */
export const NO_MEMBERSHIP_CAPABILITY: MembershipCapability = {
  canListMembers: false,
  canChangeRole: false,
  canRemoveMember: false,
  conferrableRoles: [],
  viewerUserId: null,
};
