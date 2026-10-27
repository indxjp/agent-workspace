/**
 * Everything the team screen decides, as pure functions — issue #185.
 *
 * This repository has **no jsdom and no Testing Library**: a component test is one
 * `renderToStaticMarkup` pass with no effects and no event handlers
 * (`apps/web/vitest.config.mjs`). So the rule `../projects/model.ts` established holds here too —
 * anything worth asserting lives in this file and reaches the components as a prop, and the
 * components render props and call back.
 *
 * ## What is deliberately not here
 *
 * A role policy table. #185 forbids one by name, and `../../contracts/team.ts` explains the split:
 * the grants and the conferrable set are the server's (`server/team/membership-capability.ts`), and
 * what is left in the browser is two comparisons over the list the server just returned —
 * {@link isCurrentUser} and {@link soleOwnerUserId}. Neither names a role's powers.
 */
import {
  type MembershipCapability,
  type MembershipResource,
  type MembershipRoleName,
} from '../../contracts/team';
import type { RequestProblem } from '../agents/model';

// `RequestProblem` is `../agents/model.ts`'s own, generic over any route answering this platform's
// error envelope. Re-exported so the team components have one import for the whole model, as
// `../projects/model.ts` does.
export type { RequestProblem };
export type { MembershipCapability, MembershipResource, MembershipRoleName };

/** §21's four roles, as a members table shows them. Display only; nothing is decided from this. */
const ROLE_LABELS: Readonly<Record<MembershipRoleName, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  viewer: 'Viewer',
};

/** The role name, capitalised the way §21 prints it. */
export function describeRole(role: MembershipRoleName): string {
  return ROLE_LABELS[role];
}

/**
 * An ISO-8601 timestamp from a team response, as this screen prints a date: the members table's
 * Joined column and the invitations table's expiry, acceptance and revocation.
 *
 * No relative time — "3 days ago" ages while the tab is open, and an invitation's expiry is a
 * deadline a person acts on rather than a duration. An unparsable value is returned as it arrived,
 * because inventing a date for it would be worse than showing what the server actually sent.
 */
export function formatTeamDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Is this row the signed-in caller's own? A fact about the request, not a permission. */
export function isCurrentUser(
  member: MembershipResource,
  capability: MembershipCapability,
): boolean {
  return capability.viewerUserId !== null && member.userId === capability.viewerUserId;
}

/**
 * The `users.id` of the workspace's only Owner, or `null` when it has none or several.
 *
 * The server refuses to demote or remove that member (`409 last_owner`, in both
 * `changeMembershipRole` and `deleteMembership`). This is the client's copy of the *count*, not of
 * the rule: it decides which controls to withhold, and the server still refuses a direct call.
 */
export function soleOwnerUserId(members: readonly MembershipResource[]): string | null {
  const owners = members.filter((member) => member.role === 'owner');
  return owners.length === 1 ? (owners[0]?.userId ?? null) : null;
}

/**
 * The roles this caller may move this member to, or `[]` for a row with no role control at all.
 *
 * Three narrowings, in order: the server said role changes are refused outright; the member already
 * holds the role; or this member is the last Owner, for whom every remaining option is the
 * demotion `409 last_owner` refuses.
 */
export function roleOptionsFor(
  member: MembershipResource,
  capability: MembershipCapability,
  soleOwner: string | null,
): readonly MembershipRoleName[] {
  if (!capability.canChangeRole) return [];
  if (member.userId === soleOwner) return [];
  return capability.conferrableRoles.filter((role) => role !== member.role);
}

/** May this caller remove this member? The last Owner is withheld for the same reason. */
export function canRemoveMember(
  member: MembershipResource,
  capability: MembershipCapability,
  soleOwner: string | null,
): boolean {
  return capability.canRemoveMember && member.userId !== soleOwner;
}

/**
 * Why a row offers no controls, or `null` when it offers some.
 *
 * #185 asks for the reason to be *"actionable and direct"*, which means stating it on the row
 * rather than only after a refusal. There is exactly one reason this client knows — the last-Owner
 * count it just made — and it says nothing about any other row.
 *
 * The way out is only actionable for a caller who can take it: `conferRole('admin', 'owner')` is
 * `deny`, so an Admin's `conferrableRoles` never contains `owner` and `roleOptionsFor` offers that
 * promotion on no row at all. Telling them to make one would name a control this screen does not
 * give them, so the sentence is branched on the server's own answer to the same question.
 */
export function describeWithheldControls(
  member: MembershipResource,
  capability: MembershipCapability,
  soleOwner: string | null,
): string | null {
  if (!capability.canChangeRole && !capability.canRemoveMember) return null;
  if (member.userId !== soleOwner) return null;
  return capability.conferrableRoles.includes('owner')
    ? 'Last Owner. Promote another member to Owner before changing or removing this one.'
    : 'Last Owner. Only an Owner can promote another member to Owner, so ask one before this member can be changed or removed.';
}

// ── Removal impact ─────────────────────────────────────────────────────────────────────────────

/**
 * What the removal confirmation counted, from the two list endpoints the caller already reads.
 *
 * Both numbers are complete for everyone who can reach this screen: only Owner and Admin are given
 * `memberships` by §21, and `GET /api/sessions` (`server/sessions/api.ts`) and `GET /api/projects`
 * (`app/api/projects/route.ts`) both show every workspace row to those two roles. That is why these
 * are counts rather than the hedged "…that you can see" `summariseArchiveImpact` has to use.
 */
export interface RemovalImpactCounts {
  readonly sessions: number;
  readonly projects: number;
}

/**
 * The two impact reads reduced to the counts the confirmation renders, with `null` when **either**
 * is missing. A failed read is not a zero — the reads in `./team-requests-model.ts` return `null` for it.
 */
export function removalImpactFromReads(
  sessions: number | null,
  projects: number | null,
): RemovalImpactCounts | null {
  if (sessions === null || projects === null) return null;
  return { sessions, projects };
}

function countPhrase(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${String(count)} ${plural}`;
}

/**
 * The impact sentence the confirmation renders.
 *
 * It states two different things, and the difference is load-bearing. Projects are *kept*: their
 * Both resources are retained, and exact principal ownership means neither can outlive the
 * membership principal that owns it. RF-202 will define reassignment/offboarding policy; until
 * then the server refuses removal rather than orphaning ownership or deleting history. Saying so
 * before the button is pressed is the difference between a confirmation and a surprise refusal.
 */
export function summariseRemovalImpact(counts: RemovalImpactCounts): string {
  if (counts.sessions === 0 && counts.projects === 0) {
    return 'This member owns no sessions and no projects in this workspace. Removing them ends their access here; nothing already run is deleted.';
  }
  const sessions = countPhrase(counts.sessions, 'session', 'sessions');
  const projects = countPhrase(counts.projects, 'project', 'projects');
  const kept = `${sessions} and ${projects} stay in this workspace and keep naming this member. Removing them ends their access; no history is deleted.`;
  return `${kept} A member who still owns a session or project cannot be removed until those resources are deleted or reassigned, so this removal may be refused.`;
}

/**
 * Every state the removal confirmation can be in, so a component test can render each one without a
 * browser: this repository has no jsdom, so an async state is only reachable as a prop.
 *
 * There is no `confirming` state. The dialog always opens straight into `counting`, because unlike
 * a project restore there is no removal with nothing to count — a member always has a session and
 * project count, even when it is zero.
 */
export type MemberDialogState =
  | { readonly kind: 'counting' }
  | { readonly kind: 'counted'; readonly impact: RemovalImpactCounts }
  | { readonly kind: 'impact-unavailable' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * What the request never reached, or what it came back as, in the terms
 * {@link describeMembershipFailure} needs.
 *
 * `status` is `null` for a `fetch()` that rejected, so a transport failure and a `500` with an
 * unreadable body stay distinguishable — they read identically in a {@link RequestProblem}, and
 * only one of them is the referential-integrity refusal this screen can explain.
 */
export interface MembershipFailureContext {
  readonly status: number | null;
  readonly impact: RemovalImpactCounts | null;
}

/**
 * A failed role change or removal, worded for the screen.
 *
 * Every typed refusal keeps the **server's own sentence**: `409 last_owner`,
 * `403 forbidden_role_conferral`, `403 forbidden`, `404 no_such_membership`, `400 invalid_field`
 * and `500 authorisation_undecidable` are all worded by `server/rbac/handlers.ts` and
 * `server/rbac/http.ts` in prose a person can act on, and replacing it here would be this client
 * asserting something it did not establish.
 *
 * Exactly one sentence is added, and only where the server cannot speak for itself: removing a
 * member who still owns a session violates `sessions_member_workspace_fk`, the membership routes
 * are not inside `server/http/route-error-boundaries.ts`, and the violation therefore arrives as a
 * `500` with no envelope at all. When this screen has just counted that member's sessions and found
 * some, it names them — a fact it measured, not a guess. With no count, or a count of zero, the
 * transport wording stands as it is.
 */
export function describeMembershipFailure(
  problem: RequestProblem,
  context: MembershipFailureContext,
): string {
  if (problem.kind === 'api') return problem.message;
  const sessions = context.impact?.sessions ?? 0;
  if (context.status === 500 && sessions > 0) {
    return (
      `${problem.reason} This member still owns ${countPhrase(sessions, 'session', 'sessions')} ` +
      `in this workspace, and a workspace may not hold a session owned by someone who is not a ` +
      `member. Delete or reassign those sessions first, or leave the membership in place.`
    );
  }
  return problem.reason;
}
