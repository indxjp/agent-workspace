'use client';

/**
 * `/admin/users` — the team management surface: active members (issue #185) and the pending
 * invitations section (issue #186).
 *
 * It replaces a screen that listed `GET /api/users` (names and addresses only) behind a
 * `POST /api/users` form. Everything here reads `GET /api/memberships`, which already carries every
 * field #185 asks for — the joined `users.name` (#181), the address, the role, the membership id
 * and the join timestamp — and writes through the landed `PATCH`/`DELETE` on the same resource. No
 * route changed for this screen.
 *
 * ## Where the decisions are, and where they are not
 *
 * Both capabilities are resolved by `server/team/team-capability.ts` in the page above this one and
 * arrive as props. Nothing below this line re-decides either: the browser compares only row facts —
 * whose row this is, whether the workspace has exactly one Owner, and an invitation's four
 * timestamps against the clock — and the server refuses a direct call either way. See
 * `contracts/team.ts` and `contracts/invitations.ts` for the split and why #185 and #186 both forbid
 * the alternative.
 *
 * ## Why the invitations half is its own component
 *
 * `./invitations-section.tsx` owns every invitation fetch and the one-time token reveal. It is not
 * inlined here because that state is the security-critical part of #186 — it must be provably held
 * in one place and cleared on five events — and because this file is already near the ~500-line
 * review threshold `ENGINEERING_GUIDELINES.md` sets.
 *
 * ## Why nothing is cached
 *
 * "Back or reload does not reconstruct stale tenant member data" is an acceptance criterion, and it
 * is met by keeping no client cache at all: every read is `cache: 'no-store'`, the page is
 * `force-dynamic`, there is no `localStorage`, no `sessionStorage` and no module-level memo, and
 * `server/rbac/http.ts` already answers `Cache-Control: no-store`. A bfcache-restored entry is
 * reloaded by the shell's own `pageshow` handler (`components/shell/workspace-switcher.tsx`), so a
 * workspace switch followed by Back cannot repaint the previous workspace's members.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { NO_INVITATION_CAPABILITY, type InvitationCapability } from '../../contracts/invitations';
import { NO_MEMBERSHIP_CAPABILITY } from '../../contracts/team';
import { describeTransportRejection } from '../agents/model';
import { InvitationsSection } from './invitations-section';
import { MembersTable, type MembersTableState } from './members-table';
import {
  describeMembershipFailure,
  describeRequestFailure,
  readMemberList,
  readMemberProjectCount,
  readMemberSessionCount,
  removalImpactFromReads,
  type MemberDialogState,
  type MembershipCapability,
  type MembershipResource,
  type MembershipRoleName,
  type RemovalImpactCounts,
} from './model';
import { RemoveMemberDialog } from './remove-dialog';

const JSON_READ = { cache: 'no-store', headers: { accept: 'application/json' } } as const;

/** The removal confirmation, and the member it is about. `null` while it is closed. */
interface OpenDialog {
  readonly member: MembershipResource;
  readonly state: MemberDialogState;
}

function membershipUrl(id: string): string {
  return `/api/memberships/${encodeURIComponent(id)}`;
}

/**
 * What removing this member affects, counted from the two list endpoints the caller already reads.
 *
 * Both are complete for Owner and Admin — the only roles that reach this screen — and `null` when
 * either read fails or cannot answer the question at all (`readMemberSessionCount` says when).
 * Projects are asked for with `?archived=all` so a retired project the member created is still
 * counted; it is still theirs, and the confirmation is about what stays behind.
 */
async function countRemovalImpact(userId: string): Promise<RemovalImpactCounts | null> {
  const [sessions, projects] = await Promise.all([
    fetch('/api/sessions', JSON_READ)
      .then(async (response) =>
        response.ok ? readMemberSessionCount(await response.json(), userId) : null,
      )
      .catch(() => null),
    fetch('/api/projects?archived=all', JSON_READ)
      .then(async (response) =>
        response.ok ? readMemberProjectCount(await response.json(), userId) : null,
      )
      .catch(() => null),
  ]);
  return removalImpactFromReads(sessions, projects);
}

export function TeamScreen({
  capability = NO_MEMBERSHIP_CAPABILITY,
  invitationCapability = NO_INVITATION_CAPABILITY,
}: Readonly<{
  capability?: MembershipCapability;
  invitationCapability?: InvitationCapability;
}>) {
  // The refused state is the FIRST state for a caller the server will not give the list to, not a
  // state reached after a 403: showing "Loading members…" to someone who will never be shown any is
  // a promise this screen already knows it cannot keep.
  const [table, setTable] = useState<MembersTableState>(
    capability.canListMembers ? { kind: 'loading' } : { kind: 'refused' },
  );
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [busyMembershipId, setBusyMembershipId] = useState<string | null>(null);
  const [roleProblem, setRoleProblem] = useState<string | null>(null);
  // Where focus goes when the confirmation closes: the row control that opened it, so a cancel or
  // an Escape returns the keyboard exactly where it was. It is captured rather than held as a `ref`
  // on the button itself, because the button lives inside a row this component renders through
  // `MembersTable` and there is one per member. A successful removal retargets it — see
  // `confirmRemoval`.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The screen's own heading, focusable only programmatically (`tabIndex={-1}`). It is the element
  // focus lands on after a removal, because it outlives the list reload and is what a screen reader
  // should be reading when the table underneath it has just changed.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    if (!capability.canListMembers) {
      setTable({ kind: 'refused' });
      return;
    }
    let response: Response;
    try {
      response = await fetch('/api/memberships', JSON_READ);
    } catch (error) {
      setTable({
        kind: 'failed',
        message: describeMembershipFailure(describeTransportRejection(error), {
          status: null,
          impact: null,
        }),
      });
      return;
    }
    if (!response.ok) {
      const problem = await describeRequestFailure(response, () => response.json());
      setTable({
        kind: 'failed',
        message: describeMembershipFailure(problem, { status: response.status, impact: null }),
      });
      return;
    }
    const members = readMemberList(await response.json().catch(() => null));
    setTable(
      members === null
        ? {
            kind: 'failed',
            message:
              'The member list came back in a shape this screen cannot read, so nothing is shown ' +
              'rather than a partial list. Reload to try again.',
          }
        : { kind: 'ready', members },
    );
  }, [capability.canListMembers]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(member: MembershipResource, role: MembershipRoleName) {
    setBusyMembershipId(member.id);
    setRoleProblem(null);
    let response: Response;
    try {
      response = await fetch(membershipUrl(member.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ role }),
      });
    } catch (error) {
      setBusyMembershipId(null);
      setRoleProblem(
        describeMembershipFailure(describeTransportRejection(error), {
          status: null,
          impact: null,
        }),
      );
      return;
    }
    setBusyMembershipId(null);
    if (!response.ok) {
      const problem = await describeRequestFailure(response, () => response.json());
      setRoleProblem(describeMembershipFailure(problem, { status: response.status, impact: null }));
      return;
    }
    // Reload rather than patch the row locally: the response is one membership and the last-Owner
    // count this screen gates its controls on is a property of the whole list.
    await load();
  }

  function openRemoval(member: MembershipResource) {
    setRoleProblem(null);
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog({ member, state: { kind: 'counting' } });
    void countRemovalImpact(member.userId).then((impact) => {
      // Only replace a state this same open produced; a cancel or a confirm in between owns it now.
      setDialog((current) =>
        current?.member.id === member.id && current.state.kind === 'counting'
          ? {
              member,
              state: impact === null ? { kind: 'impact-unavailable' } : { kind: 'counted', impact },
            }
          : current,
      );
    });
  }

  async function confirmRemoval() {
    const open = dialog;
    if (open === null) return;
    // The counts this screen measured, kept for the one failure it can explain: a member who still
    // owns a session is refused by `sessions_member_workspace_fk` as an unenveloped 500.
    const impact = open.state.kind === 'counted' ? open.state.impact : null;
    setDialog({ member: open.member, state: { kind: 'submitting' } });
    let response: Response;
    try {
      response = await fetch(membershipUrl(open.member.id), {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      setDialog({
        member: open.member,
        state: {
          kind: 'failed',
          message: describeMembershipFailure(describeTransportRejection(error), {
            status: null,
            impact,
          }),
        },
      });
      return;
    }
    if (!response.ok) {
      const problem = await describeRequestFailure(response, () => response.json());
      setDialog({
        member: open.member,
        state: {
          kind: 'failed',
          message: describeMembershipFailure(problem, { status: response.status, impact }),
        },
      });
      return;
    }
    // The removal succeeded, so the row's Remove button — the control that opened this dialog — is
    // about to be unmounted by the reload below. Returning focus to it would leave
    // `document.activeElement` on `<body>` the moment the new list renders, and the next Tab would
    // restart from the top of the page. The heading survives the reload, so focus goes there
    // instead; the cancel and Escape paths keep the trigger, which is still on the screen for them.
    returnFocusRef.current = headingRef.current;
    setDialog(null);
    await load();
  }

  return (
    <main className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-6">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-text">
          Users
        </h1>
        <p className="mt-1 text-sm text-muted">
          Active members of this workspace, their roles, who may change them, and who has been
          invited.
        </p>
      </div>
      <MembersTable
        state={table}
        capability={capability}
        busyMembershipId={busyMembershipId}
        roleProblem={roleProblem}
        onChangeRole={(member, role) => void changeRole(member, role)}
        onRemove={openRemoval}
      />
      <InvitationsSection capability={invitationCapability} />
      {dialog === null ? null : (
        <RemoveMemberDialog
          member={dialog.member}
          state={dialog.state}
          returnFocusTo={returnFocusRef}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmRemoval()}
        />
      )}
    </main>
  );
}
