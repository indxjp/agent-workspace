'use client';

/**
 * The "invite someone" form — issue #186.
 *
 * Presentational and prop-driven, like `./members-table.tsx`: the draft, the in-flight flag and the
 * failure sentence are all props, because this repository has no jsdom and an async state is only
 * assertable when it is one.
 *
 * Two things about it are decisions rather than layout:
 *
 * - **The role options are `capability.invitableRoles` and nothing else.** That list is
 *   `conferRole`'s own answer, resolved on the server (`server/team/invitation-capability.ts`). §21
 *   is not a privilege ladder, so a `<select>` built from an ordering would offer an Admin the
 *   option to invite a Builder, which `POST /api/invitations` answers `403` to.
 * - **The form does not render at all without `canCreateInvitation`.** #186 requires that Builder
 *   and Viewer *"cannot see or invoke invitation controls"*; the server refuses them either way, and
 *   this is the half that keeps a control they cannot use off the screen. The gate is on the grant,
 *   never on `invitableRoles` being non-empty — grant domination is reflexive, so even a Viewer's
 *   conferral set names their own role (`server/team/invitation-capability.test.ts` records why).
 */
import type { MembershipRoleName } from '../../contracts/team';
import {
  invitationRequestFrom,
  type InvitationCapability,
  type InvitationDraft,
} from './invitations-model';
import { describeRole } from './model';

const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border px-[13px] text-[13px] font-medium';
const BTN_PRIMARY = 'border-border-strong bg-surface text-text';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
const CONTROL =
  'h-8 rounded-(--radius-sm) border border-border-strong bg-surface px-2 text-[13px] text-text';

const EMAIL_ID = 'invite-email';
const ROLE_ID = 'invite-role';

interface InvitationFormProps {
  readonly capability: InvitationCapability;
  readonly draft: InvitationDraft;
  /** `true` while `POST /api/invitations` is in flight. Every control is inert. */
  readonly sending: boolean;
  /** The last failed create, worded by `describeInvitationFailure`, or `null`. */
  readonly problem: string | null;
  readonly onChange: (draft: InvitationDraft) => void;
  readonly onSubmit: () => void;
}

export function InvitationForm({
  capability,
  draft,
  sending,
  problem,
  onChange,
  onSubmit,
}: Readonly<InvitationFormProps>) {
  if (!capability.canCreateInvitation) return null;

  const submittable = invitationRequestFrom(draft) !== null && !sending;

  return (
    <form
      className="mb-4 rounded-(--radius) border border-border bg-surface p-5 shadow-(--shadow)"
      onSubmit={(event) => {
        // The default submit would navigate, and a navigation carrying the invitee's address in a
        // query string is the shape of leak #186 is about — one field away from carrying a token.
        event.preventDefault();
        if (submittable) onSubmit();
      }}
    >
      {/* `h3`: the section's own `h2` is above this, and the screen's single `h1` above that. The
          accessibility floor (`tests/browser/harness.mjs`) counts the `h1`; the nesting is for a
          screen reader walking the outline. */}
      <h3 className="text-[14px] font-semibold text-text">Invite someone to this workspace</h3>
      <p className="mt-1 text-[12.5px] text-muted">
        They receive no email. The link appears once, here, for you to relay.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-semibold text-muted" htmlFor={EMAIL_ID}>
            Email
          </label>
          <input
            id={EMAIL_ID}
            className={`${CONTROL} w-[260px]`}
            type="email"
            autoComplete="off"
            disabled={sending}
            value={draft.email}
            onChange={(event) => onChange({ ...draft, email: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-semibold text-muted" htmlFor={ROLE_ID}>
            Role
          </label>
          <select
            id={ROLE_ID}
            className={CONTROL}
            disabled={sending}
            value={draft.role ?? ''}
            onChange={(event) =>
              onChange({ ...draft, role: roleFrom(capability, event.target.value) })
            }
          >
            {/* The form opens on this rather than on a role. `invitableRoles` is ordered most
                privileged first, so a pre-selection would make Owner the default grant for an
                address typed into an untouched form; naming a neutral default here instead would be
                the client-side role policy #186 forbids. `disabled` keeps it unreachable once a
                role has been chosen, and `roleFrom` maps its `''` back to `null`. */}
            <option value="" disabled>
              Choose a role
            </option>
            {capability.invitableRoles.map((role) => (
              <option key={role} value={role}>
                {describeRole(role)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className={`${BTN} ${BTN_PRIMARY} ${submittable ? '' : BTN_DISABLED}`}
          disabled={!submittable}
        >
          {sending ? 'Sending…' : 'Send invitation'}
        </button>
      </div>
      {problem === null ? null : (
        <p className="mt-3 text-[13px] text-danger" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/**
 * The chosen option, matched against the server's list rather than trusted as a role name.
 *
 * A `<select>`'s value is a string the DOM hands back, and `null` for one the server did not offer
 * keeps the draft unsubmittable instead of sending a role the route would refuse.
 */
function roleFrom(capability: InvitationCapability, chosen: string): MembershipRoleName | null {
  return capability.invitableRoles.find((role) => role === chosen) ?? null;
}
