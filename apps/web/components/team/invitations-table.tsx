'use client';

/**
 * The invitations table — issue #186.
 *
 * Presentational and prop-driven, the same split `./members-table.tsx` uses and for the same
 * reason: every decision is `./invitations-model.ts`'s, this file renders what the state and the
 * capability say and calls back, and an async state is a prop because this repository has no jsdom.
 *
 * Every control that acts on an invitation names its invitee in its accessible name.
 * `tests/browser/harness.mjs`'s `expectBasicAccessibility` fails a control without one, and on a
 * list screen "Resend" repeated per row leaves a screen-reader user with no way to tell which
 * button they are on.
 *
 * **No cell of this table can contain a token.** `InvitationResource` has no field for one and
 * `InvitationListResponseSchema` is `.strict()`, so the only thing that could put one here is a new
 * prop — which is why the reveal is a separate component with a separate prop
 * (`./invitation-reveal.tsx`) rather than a row of this table.
 */
import {
  canResendInvitation,
  canRevokeInvitation,
  describeInvitationState,
  describeInvitationTiming,
  describeSettledInvitation,
  invitationStateOf,
  type InvitationCapability,
  type InvitationResource,
} from './invitations-model';
import { describeRole } from './model';
import { teamStrings, type TeamStrings } from './team-messages';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const CELL = 'border-b border-border px-4 py-3 text-[13px] align-top';
/**
 * Japanese has no spaces, so a narrow cell breaks it after any character: on a phone a role or a
 * date became one character per line. Short cells keep to one line, and a sentence gets a minimum
 * width; the table scrolls inside its card instead, as it already does for English.
 */
const HEAD_CELL =
  'whitespace-nowrap border-b border-border px-4 py-2 text-left text-[12px] font-semibold text-muted';
const ONE_LINE = 'whitespace-nowrap';
const SENTENCE = 'min-w-[14rem]';
const BTN =
  'inline-flex h-8 items-center rounded-(--radius-sm) border px-[13px] text-[13px] font-medium';
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
const BTN_DANGER = 'border-danger bg-surface text-danger';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';

/**
 * What the invitations section has to show, as one closed union.
 *
 * `refused` is a state of its own rather than an empty list: §21 gives `invitations` to Owner and
 * Admin only, so `GET /api/invitations` answers `403` to a Builder or a Viewer, and rendering that
 * as "nobody is waiting on an invitation here" would be a claim the response never made. #186's own
 * risk note says the same thing — a refusal must not be shown as an empty list.
 *
 * `nowMs` rides along with the rows because the four states are derived from timestamps against a
 * clock, and a component that read the clock itself could not be rendered twice with the same
 * result. It is read once, by the section, when the list arrives.
 */
export type InvitationsTableState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly invitations: readonly InvitationResource[];
      readonly nowMs: number;
    };

interface InvitationsTableProps {
  readonly state: InvitationsTableState;
  readonly capability: InvitationCapability;
  /** The invitation a resend or revoke is in flight for, or `null`. Its row's controls are inert. */
  readonly busyInvitationId: string | null;
  /** The last failed resend or revoke, worded by `describeInvitationFailure`, or `null`. */
  readonly actionProblem: string | null;
  readonly onResend: (invitation: InvitationResource) => void;
  readonly onRevoke: (invitation: InvitationResource) => void;
  /** The reader's words (UX-15 in #2086); English by default. */
  readonly strings?: TeamStrings;
}

export function InvitationsTable({
  state,
  capability,
  busyInvitationId,
  actionProblem,
  onResend,
  onRevoke,
  strings = teamStrings('en'),
}: Readonly<InvitationsTableProps>) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className={`${CARD} p-5 text-[13px] text-muted`} role="status">
          {strings.loadingInvitations}
        </p>
      );
    case 'refused':
      return (
        <p className={`${CARD} p-5 text-[13px] text-text-2`} role="status">
          {strings.invitationsRefused}
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
      throw new Error(`unhandled invitations table state ${JSON.stringify(unreachable)}`);
    }
  }

  if (state.invitations.length === 0) {
    return <p className={`${CARD} p-5 text-[13px] text-muted`}>{strings.noInvitations}</p>;
  }

  const showActions = capability.canResendInvitation || capability.canRevokeInvitation;

  return (
    <>
      {actionProblem === null ? null : (
        <p className="mb-4 text-[13px] text-danger" role="alert">
          {actionProblem}
        </p>
      )}
      <div className={CARD}>
        {/* The same horizontal scroll container `./members-table.tsx` carries, for the same measured
            reason: four columns with an address among them do not fit a phone, the actions column is
            last, and without this the controls end up off-screen with nothing able to bring them
            back. */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="px-4 py-3 text-left text-[12.5px] text-muted">
              {strings.invitationsCaption}
            </caption>
            <thead>
              <tr>
                <th className={HEAD_CELL} scope="col">
                  {strings.invitee}
                </th>
                <th className={HEAD_CELL} scope="col">
                  {strings.role}
                </th>
                <th className={HEAD_CELL} scope="col">
                  {strings.status}
                </th>
                {showActions ? (
                  <th className={HEAD_CELL} scope="col">
                    {strings.actions}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {state.invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  capability={capability}
                  nowMs={state.nowMs}
                  showActions={showActions}
                  busy={busyInvitationId === invitation.id}
                  onResend={onResend}
                  onRevoke={onRevoke}
                  strings={strings}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

interface InvitationRowProps {
  readonly invitation: InvitationResource;
  readonly capability: InvitationCapability;
  readonly nowMs: number;
  readonly showActions: boolean;
  readonly busy: boolean;
  readonly onResend: (invitation: InvitationResource) => void;
  readonly onRevoke: (invitation: InvitationResource) => void;
  readonly strings: TeamStrings;
}

function InvitationRow({
  invitation,
  capability,
  nowMs,
  showActions,
  busy,
  onResend,
  onRevoke,
  strings,
}: Readonly<InvitationRowProps>) {
  const state = invitationStateOf(invitation, nowMs);
  const resendable = canResendInvitation(state, capability);
  const revocable = canRevokeInvitation(state, capability);
  const settled = describeSettledInvitation(state, capability, strings);

  return (
    <tr>
      <td className={CELL}>
        <div className="font-semibold text-text">{invitation.email}</div>
      </td>
      <td className={`${CELL} ${ONE_LINE}`}>{describeRole(invitation.role, strings)}</td>
      <td className={`${CELL} ${ONE_LINE}`}>
        <div className="text-text">{describeInvitationState(state, strings)}</div>
        <div className="text-muted">{describeInvitationTiming(invitation, state, strings)}</div>
      </td>
      {showActions ? (
        <td className={CELL}>
          <div className="flex items-center gap-2">
            {resendable ? (
              <button
                type="button"
                aria-label={strings.resendLabel(invitation.email)}
                className={`${BTN} ${BTN_DEFAULT} ${busy ? BTN_DISABLED : ''}`}
                disabled={busy}
                onClick={() => onResend(invitation)}
              >
                {strings.resend}
              </button>
            ) : null}
            {revocable ? (
              <button
                type="button"
                aria-label={strings.revokeLabel(invitation.email)}
                className={`${BTN} ${BTN_DANGER} ${busy ? BTN_DISABLED : ''}`}
                disabled={busy}
                onClick={() => onRevoke(invitation)}
              >
                {strings.revoke}
              </button>
            ) : null}
            {settled === null ? null : (
              <span className={`${SENTENCE} text-[12.5px] text-muted`}>{settled}</span>
            )}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
