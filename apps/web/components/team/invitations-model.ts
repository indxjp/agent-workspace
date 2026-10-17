/**
 * Everything the invitations section decides, as pure functions — issue #186.
 *
 * The rule `./model.ts` states for the members half holds here for the same reason: this repository
 * has **no jsdom and no Testing Library**, so a component test is one `renderToStaticMarkup` pass
 * with no effects and no event handlers (`apps/web/vitest.config.mjs`). Anything worth asserting
 * lives in this file and reaches the components as a prop.
 *
 * ## The token
 *
 * Exactly one exported value in this module carries the secret: {@link RevealedInvitation}, and its
 * only producer is {@link revealIssuedInvitation} reading a create or resend response. Nothing else
 * here accepts a token, returns one, or is given the shape that holds one — not
 * {@link invitationStateOf}, not {@link describeInvitationState}, not
 * {@link describeInvitationFailure}. That is deliberate and it is tested: a function that can never
 * see the token can never interpolate it into a sentence a screen, a log or an error boundary then
 * renders.
 *
 * `readInvitationList` is the other half of the same guarantee. `InvitationListResponseSchema` is
 * `.strict()`, so the create response — which does carry a token — cannot be read as list rows.
 *
 * ## What is deliberately not here
 *
 * A role policy table. #186 asks for unauthorized controls to be hidden *"while retaining
 * server-side refusal as the security boundary"*, and `../../contracts/invitations.ts` explains the
 * split: the grants and the invitable set are the server's
 * (`server/team/invitation-capability.ts`), and what is left in the browser is a comparison of four
 * timestamps against the clock.
 */
import {
  InvitationListResponseSchema,
  IssuedInvitationResponseSchema,
  type InvitationCapability,
  type InvitationResource,
} from '../../contracts/invitations';
import type { MembershipRoleName } from '../../contracts/team';
import { formatTeamDate, type RequestProblem } from './model';

export type { InvitationCapability, InvitationResource };

/**
 * `GET /api/invitations` → the rows this screen may trust, or `null` for a body it cannot read.
 *
 * `null` rather than a throw, and rather than an empty list: an empty invitations table is a claim
 * ("nobody is waiting on an invitation here") that a malformed response is no evidence for, and
 * this section has a failed state for exactly that reason — the same decision `readMemberList`
 * made.
 */
export function readInvitationList(body: unknown): readonly InvitationResource[] | null {
  const parsed = InvitationListResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.invitations : null;
}

// ── the four states ────────────────────────────────────────────────────────────────────────────

/**
 * The four states #186 asks the table to show.
 *
 * They are derived, not read: `InvitationSummary` carries `revokedAt`, `acceptedAt` and `expiresAt`
 * and **no state field** (`server/rbac/directory.ts`), and #186 puts an API change out of scope.
 */
export type InvitationState = 'revoked' | 'accepted' | 'expired' | 'pending';

/**
 * Which state this row is in, at `nowMs`.
 *
 * The precedence — revoked, then accepted, then expired, then pending — is fixed because a row can
 * satisfy more than one of them at once and the answer has to be stable. It follows the server's
 * own order of refusal: `resendInvitation` and `revokeInvitation` both test `revokedAt` and
 * `acceptedAt` before anything else (`server/invitations/handlers.ts` via
 * `packages/core/src/db/repositories/directory.ts`), and `acceptInvitation` checks revoked, then
 * accepted, then expiry. An expired row that was also revoked is **revoked**: revocation is the
 * deliberate act, expiry is the clock, and only one of the two tells a person why nothing can be
 * done with the row.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the boundary is testable and this stays
 * a pure function (the clock is read once, by the component, at render).
 */
export function invitationStateOf(invitation: InvitationResource, nowMs: number): InvitationState {
  if (invitation.revokedAt !== null) return 'revoked';
  if (invitation.acceptedAt !== null) return 'accepted';
  // `<=` rather than `<`: the accept path refuses a row whose expiry has exactly arrived
  // (`expiresAt <= now` is `expired` there), so the table must not call the same row pending.
  return new Date(invitation.expiresAt).getTime() <= nowMs ? 'expired' : 'pending';
}

const STATE_LABELS: Readonly<Record<InvitationState, string>> = {
  pending: 'Pending',
  expired: 'Expired',
  accepted: 'Accepted',
  revoked: 'Revoked',
};

/** The state, as the table's Status column prints it. */
export function describeInvitationState(state: InvitationState): string {
  return STATE_LABELS[state];
}

/**
 * The date the state is about, worded so the column says *which* timestamp it is showing.
 *
 * Each state has one timestamp that matters and three that do not: a revoked row's expiry is
 * irrelevant, and an accepted row's is too. Printing "Expires 21 Sep" beside "Revoked" would invite
 * a person to wait for something that will never happen.
 */
export function describeInvitationTiming(
  invitation: InvitationResource,
  state: InvitationState,
): string {
  switch (state) {
    case 'revoked':
      return invitation.revokedAt === null ? '' : `Revoked ${formatTeamDate(invitation.revokedAt)}`;
    case 'accepted':
      return invitation.acceptedAt === null
        ? ''
        : `Accepted ${formatTeamDate(invitation.acceptedAt)}`;
    case 'expired':
      return `Expired ${formatTeamDate(invitation.expiresAt)}`;
    case 'pending':
      return `Expires ${formatTeamDate(invitation.expiresAt)}`;
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled invitation state ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── which actions a row offers ─────────────────────────────────────────────────────────────────

/**
 * May this caller resend this row?
 *
 * `resendInvitation`'s outcomes are `resent`, `no-such-invitation`, `already-accepted` and
 * `revoked` — **expiry is not among them**, and the repository mints a fresh expiry with the fresh
 * token. So an expired row is resendable, and that is the only way out of the state a stale
 * invitation leaves an address in: the pending-uniqueness index is partial on "neither accepted nor
 * revoked" (`packages/core/src/db/schema/invitations.ts`), so a new `POST` for the same address is
 * still `409 already_invited` while the expired row sits there.
 */
export function canResendInvitation(
  state: InvitationState,
  capability: InvitationCapability,
): boolean {
  if (!capability.canResendInvitation) return false;
  return state === 'pending' || state === 'expired';
}

/**
 * May this caller revoke this row?
 *
 * An accepted invitation has nothing left to revoke — the person is a member, and removing them is
 * the members table's `DELETE /api/memberships/:id`, which the server says in its own
 * `409 already_accepted`. A revoked row is already revoked; the route is idempotent about it, but
 * offering the control again would suggest something is still pending.
 */
export function canRevokeInvitation(
  state: InvitationState,
  capability: InvitationCapability,
): boolean {
  if (!capability.canRevokeInvitation) return false;
  return state === 'pending' || state === 'expired';
}

/**
 * Why a row offers no action, or `null` when it offers one or when this caller has no actions at
 * all.
 *
 * Stated on the row rather than only after a refusal, the way `describeWithheldControls` states the
 * last-Owner reason: a caller who *can* act needs to know that this particular row is finished
 * rather than that the screen is broken. A caller with no invitation grants gets `null`, because
 * the whole section is already a refusal for them and a per-row note would be noise.
 */
export function describeSettledInvitation(
  state: InvitationState,
  capability: InvitationCapability,
): string | null {
  if (!capability.canResendInvitation && !capability.canRevokeInvitation) return null;
  if (state === 'accepted') return 'Accepted. Manage this person in the members table above.';
  if (state === 'revoked') return 'Revoked. Send a new invitation if they still need access.';
  return null;
}

// ── the one-time reveal ────────────────────────────────────────────────────────────────────────

/**
 * The secret, for as long as one component holds it in a `useState` — issue #186's one-time reveal.
 *
 * `link` **is** the token: `createManualLinkInvitationSender` builds
 * `/accept-invitation?id=…&token=…` (`server/invitations/send-invitation.ts`), so the query string
 * carries it. There is no separate `token` field here on purpose — a second copy is a second thing
 * to fail to clear, and the link is what a person actually needs to relay.
 *
 * `warning` is the server's own sentence stating that this is the only time the token is shown. It
 * is carried rather than reworded so the reveal states the guarantee the server actually made, and
 * so a resend's *"The previous token no longer works"* reaches the screen instead of a generic copy.
 *
 * Nothing in this program may put a value of this type into `localStorage`, `sessionStorage`, a URL,
 * a `router` call, an `<a href>`, a log, an analytics event, or an error message.
 * `invitations-section.tsx` owns the single `useState` that holds one and every path that clears it.
 */
export interface RevealedInvitation {
  /** Who it invites. Not a secret; it is the only way to tell which reveal this is. */
  readonly email: string;
  /** The absolute accept link, token included. */
  readonly link: string;
  /** The server's own one-time-only sentence. */
  readonly warning: string;
}

/**
 * A create or resend response → the reveal, or `null` for a body this screen cannot read.
 *
 * `origin` is `window.location.origin`, passed in rather than read here so this stays pure. The
 * server returns a **relative** link, and a relative link is not something a person can paste into
 * a message to the invitee; composing the absolute one in the browser is a client-side composition
 * and not an API change. It is composed with `new URL` rather than by concatenation so a link the
 * server ever changed the shape of cannot produce a string that is not a URL at all.
 *
 * `null` deliberately loses the token. A body that failed to parse has a token in it somewhere, and
 * the honest report is "this response could not be read" — with no fragment of it quoted, which is
 * exactly the error path that would otherwise leak the secret into a message.
 */
export function revealIssuedInvitation(body: unknown, origin: string): RevealedInvitation | null {
  const parsed = IssuedInvitationResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const { invitation, link, warning } = parsed.data;
  let absolute: string;
  try {
    absolute = new URL(link, origin).toString();
  } catch {
    return null;
  }
  return { email: invitation.email, link: absolute, warning };
}

/**
 * Whether the copy control has been used, and how it went.
 *
 * `unavailable` is a real state rather than a silent failure: `navigator.clipboard` is absent
 * outside a secure context and its `writeText` rejects when the document is not focused or the
 * permission is denied. The fallback it produces names no part of the link — see
 * {@link describeCopyState}.
 */
export type CopyState = 'untouched' | 'copied' | 'unavailable';

/**
 * What the reveal says beneath its copy control, or `null` before it has been used.
 *
 * Neither sentence contains the link. That is the point: a failure message that quoted what it
 * failed to copy would put the token in a second element, and #186 requires it in exactly one.
 */
export function describeCopyState(state: CopyState): string | null {
  switch (state) {
    case 'untouched':
      return null;
    case 'copied':
      return 'Link copied. Send it to the person you invited; it is not shown again.';
    case 'unavailable':
      return 'This browser would not give the page the clipboard. Select the link above and copy it before leaving this screen.';
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled copy state ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── the create form ────────────────────────────────────────────────────────────────────────────

/**
 * What the create form has in its fields, as the section holds it.
 *
 * The role is `MembershipRoleName | null` rather than defaulted to one: which roles this caller may
 * invite is the server's answer (`invitableRoles`), so the browser cannot pick a default from a
 * role name of its own, and a caller whose list is empty has nothing to pre-select.
 */
export interface InvitationDraft {
  readonly email: string;
  readonly role: MembershipRoleName | null;
}

/**
 * A fresh form: no address and **no role**, so a role is always an explicit choice.
 *
 * There is no pre-selection at all, and neither half of the alternative is available. Naming a
 * default here — `'viewer'` — would be the client-side role policy #186 forbids, and taking the
 * first of `invitableRoles` takes the *most privileged* one: `conferrableRolesFor` filters
 * `ROLES = ['owner', 'admin', 'builder', 'viewer']` in that order, so an Owner's form would open on
 * Owner and an address typed into an otherwise untouched form would be granted the workspace. The
 * form renders a disabled placeholder option for this value and `invitationRequestFrom` refuses it,
 * so the submit control stays inert until someone picks.
 */
export const EMPTY_INVITATION_DRAFT: InvitationDraft = { email: '', role: null };

/**
 * The request body for `POST /api/invitations`, or `null` when the draft is not submittable.
 *
 * The address check is deliberately one containment test and not a grammar: `readEmail`
 * (`server/rbac/handlers.ts`) is the boundary that decides what this API accepts, and a second,
 * stricter pattern in the browser would refuse addresses the server would take. What this rejects
 * is only the two the person can see are wrong — nothing typed, and no `@` — so the form does not
 * spend a round trip to learn it.
 */
export function invitationRequestFrom(
  draft: InvitationDraft,
): { readonly email: string; readonly role: MembershipRoleName } | null {
  const email = draft.email.trim();
  if (email.length === 0 || !email.includes('@')) return null;
  return draft.role === null ? null : { email, role: draft.role };
}

// ── failures ───────────────────────────────────────────────────────────────────────────────────

/**
 * A failed invitation request, worded for the screen.
 *
 * Every typed refusal keeps the **server's own sentence**. `409 already_invited` already ends with
 * *"Resend it, or revoke it before sending a new one"*; `409 already_accepted`,
 * `409 invitation_revoked`, `403 forbidden_role_conferral`, `400 invalid_field` and
 * `503 invitations_runtime_not_configured` are all worded by `server/invitations/handlers.ts` and
 * `app/api/invitations/**` in prose a person can act on. Replacing any of them here would be this
 * client asserting something it did not establish.
 *
 * Exactly one sentence is added, and only where the server cannot speak for itself:
 * `404 no_such_invitation` is deliberately identical for a foreign id and a nonexistent one
 * (PR #175's concealment finding), so what the server cannot say — and what is true whenever this
 * screen provokes it — is that the row it was showing is gone and the list is stale.
 *
 * This function never receives a token: its only argument is a {@link RequestProblem}, built from
 * an error envelope, and the two responses that carry a token are both successes.
 */
export function describeInvitationFailure(problem: RequestProblem): string {
  if (problem.kind !== 'api') return problem.reason;
  if (problem.code === 'no_such_invitation') {
    return `${problem.message} The list on this screen is out of date; reload it.`;
  }
  return problem.message;
}
