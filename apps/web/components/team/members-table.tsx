'use client';

/**
 * The active-member table — issue #185.
 *
 * Presentational and prop-driven: it renders what {@link MembersTableState} and the capability say
 * and calls back. It holds no fetch, no capability decision and no async state of its own, for the
 * reason `../projects/project-archive.tsx` states for the same split — this repository has no
 * jsdom, so an async state is only assertable if it is a prop.
 *
 * Every control that acts on a member names that member in its accessible name. `tests/browser/`'s
 * `expectBasicAccessibility` fails a control without one, and on a list screen "Remove" repeated
 * per row is exactly the shape of name that leaves a screen-reader user with no way to tell which
 * button they are on.
 */
import {
  canRemoveMember,
  describeRole,
  describeWithheldControls,
  formatTeamDate,
  isCurrentUser,
  roleOptionsFor,
  soleOwnerUserId,
  type MembershipCapability,
  type MembershipResource,
  type MembershipRoleName,
} from './model';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const CELL = 'border-b border-border px-4 py-3 text-[13px] align-top';
const HEAD_CELL = 'border-b border-border px-4 py-2 text-left text-[12px] font-semibold text-muted';
const CONTROL =
  'h-8 rounded-(--radius-sm) border border-border-strong bg-surface px-2 text-[13px] text-text';
const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border border-danger bg-surface px-[13px] text-[13px] font-medium text-danger';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';

/**
 * What the screen has to show, as one closed union.
 *
 * `refused` is a state of its own rather than an empty list: §21 gives `memberships` to Owner and
 * Admin only, so `GET /api/memberships` answers `403` to a Builder or a Viewer, and rendering that
 * as "this workspace has no members" would be a claim the response never made.
 */
export type MembersTableState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly members: readonly MembershipResource[] };

interface MembersTableProps {
  readonly state: MembersTableState;
  readonly capability: MembershipCapability;
  /** The membership a `PATCH`/`DELETE` is in flight for, or `null`. Its row's controls are inert. */
  readonly busyMembershipId: string | null;
  /** The last failed role change, worded by `describeMembershipFailure`, or `null`. */
  readonly roleProblem: string | null;
  readonly onChangeRole: (member: MembershipResource, role: MembershipRoleName) => void;
  readonly onRemove: (member: MembershipResource) => void;
}

export function MembersTable({
  state,
  capability,
  busyMembershipId,
  roleProblem,
  onChangeRole,
  onRemove,
}: Readonly<MembersTableProps>) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className={`${CARD} p-5 text-[13px] text-muted`} role="status">
          Loading members…
        </p>
      );
    case 'refused':
      // Not a disabled table and not an empty one. The server refuses this caller the list itself,
      // and the only honest rendering of a refusal is to say it was refused.
      return (
        <p className={`${CARD} p-5 text-[13px] text-text-2`} role="status">
          Managing members is not part of your role in this workspace, so its member list is not
          shown here. Ask an Owner or an Admin if you need a change made.
        </p>
      );
    case 'failed':
      return (
        <p className={`${CARD} p-5 text-[13px] text-danger`} role="alert">
          {state.message}
        </p>
      );
    case 'ready':
      break;
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled members table state ${JSON.stringify(unreachable)}`);
    }
  }

  if (state.members.length === 0) {
    return (
      <p className={`${CARD} p-5 text-[13px] text-muted`}>
        This workspace has no members yet. Members join by accepting an invitation.
      </p>
    );
  }

  const soleOwner = soleOwnerUserId(state.members);
  const showActions = capability.canChangeRole || capability.canRemoveMember;

  return (
    <>
      {roleProblem === null ? null : (
        <p className="mb-4 text-[13px] text-danger" role="alert">
          {roleProblem}
        </p>
      )}
      <div className={CARD}>
        {/* The table is wider than a phone: four columns, one of them an address, and the actions
            column last. Without this scroll container it simply overflows the card and the layout
            viewport, which puts the Remove control off-screen with nothing able to bring it back —
            a member an Owner cannot remove on a phone. `overflow-x-auto` makes the overflow this
            card's to scroll, which is what `../agents/agents-list.tsx`,
            `../run/history-screen.tsx` and `../resources/resource-screens.tsx` already do with
            their own wide tables. */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="px-4 py-3 text-left text-[12.5px] text-muted">
              Active members of this workspace and the role each one holds.
            </caption>
            <thead>
              <tr>
                <th className={HEAD_CELL} scope="col">
                  Member
                </th>
                <th className={HEAD_CELL} scope="col">
                  Role
                </th>
                <th className={HEAD_CELL} scope="col">
                  Joined
                </th>
                {showActions ? (
                  <th className={HEAD_CELL} scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {state.members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  capability={capability}
                  soleOwner={soleOwner}
                  showActions={showActions}
                  busy={busyMembershipId === member.id}
                  onChangeRole={onChangeRole}
                  onRemove={onRemove}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

interface MemberRowProps {
  readonly member: MembershipResource;
  readonly capability: MembershipCapability;
  readonly soleOwner: string | null;
  readonly showActions: boolean;
  readonly busy: boolean;
  readonly onChangeRole: (member: MembershipResource, role: MembershipRoleName) => void;
  readonly onRemove: (member: MembershipResource) => void;
}

function MemberRow({
  member,
  capability,
  soleOwner,
  showActions,
  busy,
  onChangeRole,
  onRemove,
}: Readonly<MemberRowProps>) {
  const roles = roleOptionsFor(member, capability, soleOwner);
  const removable = canRemoveMember(member, capability, soleOwner);
  const withheld = describeWithheldControls(member, capability, soleOwner);

  return (
    <tr>
      <td className={CELL}>
        <div className="font-semibold text-text">
          {member.name}
          {isCurrentUser(member, capability) ? (
            <span className="ml-2 rounded-(--radius-sm) border border-border-strong px-1.5 py-0.5 text-[11px] font-normal text-muted">
              You
            </span>
          ) : null}
        </div>
        <div className="text-muted">{member.email}</div>
      </td>
      <td className={CELL}>{describeRole(member.role)}</td>
      <td className={CELL}>{formatTeamDate(member.createdAt)}</td>
      {showActions ? (
        <td className={CELL}>
          <div className="flex items-center gap-2">
            {roles.length === 0 ? null : (
              <select
                aria-label={`Role for ${member.name}`}
                className={CONTROL}
                disabled={busy}
                value={member.role}
                onChange={(event) => {
                  const chosen = roles.find((role) => role === event.target.value);
                  if (chosen !== undefined) onChangeRole(member, chosen);
                }}
              >
                {/* The held role is an option so the control shows it, and choosing it is a no-op
                    the `onChange` above never turns into a request. */}
                <option value={member.role}>{describeRole(member.role)}</option>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {describeRole(role)}
                  </option>
                ))}
              </select>
            )}
            {removable ? (
              <button
                type="button"
                aria-label={`Remove ${member.name}`}
                className={`${BTN} ${busy ? BTN_DISABLED : ''}`}
                disabled={busy}
                onClick={() => onRemove(member)}
              >
                Remove
              </button>
            ) : null}
            {withheld === null ? null : (
              <span className="text-[12.5px] text-muted">{withheld}</span>
            )}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
