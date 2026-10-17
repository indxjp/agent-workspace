/**
 * "Who is looking at the team screen, and what role do they hold in the workspace their session
 * names?" — resolved once, against the directory (issue #186).
 *
 * It exists because `/admin/users` now gates two different resources. `membership-capability.ts`
 * (#185) and `invitation-capability.ts` (#186) each ask `decide()` about their own routes, but both
 * need the same two directory reads first, and doing them twice per render would double the cost of
 * the screen for an answer that cannot differ between them. The resolution is therefore here, the
 * grants stay with their resource, and `team-capability.ts` composes the two.
 *
 * The role is read from the directory, never from the session token — the same rule
 * `rbac/principal.ts` and `app/(shell)/layout.tsx` follow, so a membership removed or re-roled since
 * the cookie was minted takes effect on this render.
 *
 * `null` is the answer to every question that could not be settled: no user row, no membership in
 * the session's workspace, or a membership carrying a role §21 does not name. Each caller turns that
 * into its own all-deny capability, because a control that appears because a check could not run is
 * the failure ADR-0015 exists to forbid.
 */
import type { DirectoryRoot } from '../rbac/directory';
import { parseRole, type Role } from '../rbac/roles';

/** The signed-in caller, as the team screen's capabilities need them. Nothing about the session. */
export interface TeamViewer {
  readonly userId: string;
  readonly role: Role;
}

/** What a team capability needs of the directory: the two reads, and nothing that can write. */
export type TeamViewerDirectory = Pick<DirectoryRoot, 'findUserByEmail' | 'membershipsForUser'>;

/** The session fields this resolution reads: the subject address and the workspace slug. */
export interface TeamViewerSession {
  readonly sub: string;
  readonly ws: string;
}

export async function resolveTeamViewer(
  directory: TeamViewerDirectory,
  session: TeamViewerSession,
): Promise<TeamViewer | null> {
  const user = await directory.findUserByEmail(session.sub);
  if (user === null) return null;
  const memberships = await directory.membershipsForUser(user.id);
  const current = memberships.find((membership) => membership.workspaceSlug === session.ws);
  if (current === undefined) return null;
  // A membership row carrying something §21 does not name is not a Viewer, it is a row this program
  // refuses to authorise from (`rbac/roles.ts`). Refusing here rather than only in the grant lookups
  // keeps the viewer's identity out of the answer too: "is this row me?" is also a capability, and
  // it has no business being answered from a corrupt row.
  const role = parseRole(current.role);
  return role === null ? null : { userId: user.id, role };
}
