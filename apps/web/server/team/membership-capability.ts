/**
 * "May the person looking at the team screen list, re-role or remove a member — and which roles may
 * they hand out?" — answered on the server, by the same `decide()` table and the same `conferRole`
 * comparison the membership routes themselves consult (issue #185).
 *
 * Issue #185 forbids the obvious client implementation by name: *"gate controls from
 * server-provided capability data; do not introduce a client-side role policy table"*. It also
 * requires that Builder and Viewer *"do not see unauthorized controls"*, which needs an answer
 * **before** a control is rendered — so the answer is computed where the policy lives and handed
 * across. `app/(shell)/admin/users/page.tsx` is a server component, so this runs there and arrives
 * at the browser as a prop. `../projects/archive-capability.ts` (issue #184) is the precedent this
 * follows; the differences are the three routes and the conferral set.
 *
 * ## Why the ownership answers are the routes' own
 *
 * `GET /api/memberships` passes `not-applicable` and the `PATCH`/`DELETE` pair passes `unknown`
 * (`app/api/memberships/route.ts`, `app/api/memberships/[id]/route.ts`, whose header explains why).
 * Those exact values are what this asks `decide()`, so the screen's answer and the route's answer
 * are the same cell of the matrix rather than two readings of it. `unknown` denies for every grant
 * narrower than `any`, which is why an Admin — whose grant over `memberships` is `any` — is
 * admitted and a Builder is not.
 *
 * ## Why conferral is asked rather than tabulated
 *
 * `PATCH /api/memberships/:id` does not merely check that the caller may write memberships: it
 * routes the requested role through `readConferredRole` → `conferRole`, which compares grants over
 * every resource and operation (`../rbac/conferral.ts`). §21 is **not** a privilege ladder — Admin
 * has no grant over `projects` and cannot run a connector while Builder can — so the set of roles
 * an Admin may confer is `['admin','viewer']` and cannot be derived from any ordering. Offering a
 * `<select>` built from anything but `conferRole` would offer options the route answers `403` to.
 *
 * ## Why not a probe
 *
 * `archive-capability.ts` rejects a capability probe because the only probe available there is a
 * write that loses a race. Here it is worse: the only no-op `PATCH` is "set the role this member
 * already has", which is a real write through `changeMembershipRole` and a real audit event.
 *
 * ## Unresolvable means refused
 *
 * No RBAC runtime, no session, no user row, no membership in the session's workspace, or a role the
 * table does not recognise — every one of them answers `NO_MEMBERSHIP_CAPABILITY`. A control that
 * appears because a check could not run is the failure ADR-0015 exists to forbid. Settling which of
 * those held is `./team-viewer.ts`'s job, because issue #186 gave this screen a second resource to
 * gate and the resolution cannot usefully differ between the two.
 */
import {
  NO_MEMBERSHIP_CAPABILITY,
  type MembershipCapability,
  type MembershipRoleName,
} from '../../contracts/team';
import { conferRole } from '../rbac/conferral';
import { decide, type Ownership } from '../rbac/decide';
import { parseRole, ROLES } from '../rbac/roles';
import type { TeamViewer } from './team-viewer';

/** The three route questions the team screen's controls depend on. */
export interface MembershipGrants {
  readonly canListMembers: boolean;
  readonly canChangeRole: boolean;
  readonly canRemoveMember: boolean;
}

const NO_GRANTS: MembershipGrants = {
  canListMembers: false,
  canChangeRole: false,
  canRemoveMember: false,
};

/**
 * Ask `decide()` the three membership routes, with the ownership each route actually passes.
 *
 * Exported so the matrix test can drive every role without a session or a database.
 */
export function membershipGrantsForRole(role: string): MembershipGrants {
  const parsed = parseRole(role);
  if (parsed === null) return NO_GRANTS;
  // `decide()` reads the specification's path notation, not Next.js's `[id]` folder spelling.
  // A page-render capability probe, never a real bearer credential: this screen is reached by a
  // session cookie, and a browser token's scope grammar has no cell over `memberships` at all.
  const ask = (method: string, path: string, ownership: Ownership): boolean =>
    decide({ role: parsed, method, path, ownership, scope: null }).effect === 'allow';
  return {
    canListMembers: ask('GET', '/api/memberships', 'not-applicable'),
    canChangeRole: ask('PATCH', '/api/memberships/:id', 'unknown'),
    canRemoveMember: ask('DELETE', '/api/memberships/:id', 'unknown'),
  };
}

/**
 * The roles this caller may hand out, from `conferRole` itself.
 *
 * `deny` and `refuse` are both excluded: `readConferredRole` turns the first into a `403` and the
 * second into a `500`, and neither is an option a person should be offered.
 */
export function conferrableRolesFor(role: string): readonly MembershipRoleName[] {
  return ROLES.filter((candidate) => conferRole(role, candidate).effect === 'allow');
}

/**
 * The capability for a resolved viewer, or the all-deny answer for one who could not be resolved.
 *
 * Pure and synchronous: the directory reads happen once in `./team-viewer.ts`, so this is only the
 * three `decide()` questions, the conferral set, and the viewer's own id — the one fact the browser
 * compares a row against.
 */
export function membershipCapabilityForViewer(viewer: TeamViewer | null): MembershipCapability {
  if (viewer === null) return NO_MEMBERSHIP_CAPABILITY;
  return {
    ...membershipGrantsForRole(viewer.role),
    conferrableRoles: conferrableRolesFor(viewer.role),
    viewerUserId: viewer.userId,
  };
}
