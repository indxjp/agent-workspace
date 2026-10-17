/**
 * "May the person looking at this page archive this project?" — answered on the server, by the same
 * `decide()` table `POST /api/projects/:id/archive` itself consults (issue #184).
 *
 * Issue #184 forbids the obvious client implementation by name: *"do not duplicate authorization
 * rules in a client-side role table"*. It also requires that *"refused users see no actionable
 * control"*, which needs an answer **before** the control is rendered — so the answer has to be
 * computed somewhere the policy lives and handed across. `app/(shell)/projects/[id]/page.tsx` is a
 * server component, so this runs there and arrives at the browser as a prop.
 *
 * ## Why two questions and not one
 *
 * `requireProjectAccess` (`./http.ts`) resolves ownership per project — a Builder may retire a
 * project they created and not one somebody else did — and it does so from a row this page has not
 * read yet. Rather than read the project here (a second, racing read of a row the client is already
 * fetching), both cells of the ownership split are asked for and the *comparison* is left to the
 * browser, where `createdBy` and the viewer's id are both already in hand. The comparison is a fact
 * about the request; the grants are the policy, and they are only ever `decide()`'s.
 *
 * ## Why not a probe
 *
 * The `classifyUserFilterProbe` pattern (`components/run/history.ts`) reads a real server answer
 * instead of guessing, and it is the right shape for a *read*. There is no read here: the only
 * probe available for these routes is the idempotent no-op transition — `restore` on an active
 * project, `archive` on an archived one — and that is a **write** that loses a race. If another
 * member archives the project between the page load and the probe, the probe silently un-archives
 * it. A capability check must not be able to change state.
 *
 * ## Unresolvable means refused
 *
 * No session, no RBAC runtime, no user row, no membership in the session's workspace, or a role the
 * table does not recognise — every one of them answers {@link NO_ARCHIVE_CAPABILITY}. A control
 * that appears because a check could not run is the failure ADR-0015 exists to forbid. The cost of
 * being wrong in this direction is a hidden control on a page whose server routes still work; the
 * cost of being wrong in the other is an actionable control that answers 404.
 */
import type { ProjectArchiveCapability } from '../../contracts/projects';
import { getSession } from '../auth';
import { decide } from '../rbac/decide';
import type { DirectoryRoot } from '../rbac/directory';
import { parseRole } from '../rbac/roles';
import { currentRbacRuntime } from '../rbac/runtime';

/** The answer for a caller nothing could be established about. Every field denies. */
export const NO_ARCHIVE_CAPABILITY: ProjectArchiveCapability = {
  canArchiveOwn: false,
  canArchiveOther: false,
  viewerPrincipalId: null,
};

/**
 * Ask `decide()` both halves of the ownership split for the archive route.
 *
 * `restore` is not asked separately: `rbac/declarations/W9-PROJ-183.ts` classifies both segments as
 * writes on the same `projects` resource, so the two questions have one answer by construction. The
 * capability test asserts that, rather than this comment claiming it.
 *
 * Exported so the test can drive the role matrix without a session or a database.
 */
export function archiveGrantsForRole(role: string): {
  readonly canArchiveOwn: boolean;
  readonly canArchiveOther: boolean;
} {
  const parsed = parseRole(role);
  if (parsed === null) return { canArchiveOwn: false, canArchiveOther: false };
  const ask = (ownership: 'own' | 'other'): boolean =>
    decide({
      role: parsed,
      method: 'POST',
      // `decide()` reads the specification's path notation, not Next.js's `[id]` folder spelling.
      path: '/api/projects/:id/archive',
      ownership,
      // A page-render capability probe, never a real bearer credential: this page is reached by a
      // session cookie, and a browser token's scope grammar has no cell over `projects` at all.
      scope: null,
    }).effect === 'allow';
  return { canArchiveOwn: ask('own'), canArchiveOther: ask('other') };
}

/** The two fields of a verified session this needs: who is calling, and in which workspace. */
export interface CapabilitySession {
  /** `users.email`, lower-cased — the session's subject. */
  readonly sub: string;
  /** `workspaces.slug` — the workspace the session is for. */
  readonly ws: string;
}

/**
 * Resolve a capability from a verified session against a directory.
 *
 * The role is read from the directory, never from the session token — the same rule
 * `rbac/principal.ts` and `app/(shell)/layout.tsx` already follow, so a membership removed since
 * the cookie was minted takes effect on this render.
 *
 * The directory is a parameter rather than a lookup so the role matrix is testable without a
 * session cookie, which `next/headers` will not produce outside a real request.
 */
export async function archiveCapabilityFor(
  directory: Pick<DirectoryRoot, 'findUserByEmail' | 'membershipsForUser'>,
  session: CapabilitySession,
): Promise<ProjectArchiveCapability> {
  const user = await directory.findUserByEmail(session.sub);
  if (user === null) return NO_ARCHIVE_CAPABILITY;
  const memberships = await directory.membershipsForUser(user.id);
  const current = memberships.find((membership) => membership.workspaceSlug === session.ws);
  if (current === undefined) return NO_ARCHIVE_CAPABILITY;
  return { ...archiveGrantsForRole(current.role), viewerPrincipalId: current.principalId };
}

/**
 * The signed-in caller's archive capability for the current request.
 *
 * The RBAC runtime is checked before the session deliberately: an unwired runtime is this
 * application's declared fail-closed state (`rbac/runtime.ts`), it is the cheaper question, and
 * asking it first means the answer for an unconfigured deployment does not depend on `next/headers`
 * having a request to read.
 */
export async function resolveProjectArchiveCapability(): Promise<ProjectArchiveCapability> {
  const runtime = currentRbacRuntime();
  if (runtime === null) return NO_ARCHIVE_CAPABILITY;
  const session = await getSession();
  if (session === null) return NO_ARCHIVE_CAPABILITY;
  return archiveCapabilityFor(runtime.directory, session);
}
