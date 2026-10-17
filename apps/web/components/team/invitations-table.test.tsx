import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY } from '../../contracts/invitations';
import type { InvitationCapability, InvitationResource } from './invitations-model';
import { InvitationsTable, type InvitationsTableState } from './invitations-table';

/**
 * The invitations table, rendered one state at a time — issue #186.
 *
 * This repository has no jsdom and no Testing Library, so every state below is a prop. The
 * load-bearing assertions are the negative ones: a capability that denies must produce no Resend
 * and no Revoke button **anywhere** in the markup, which is what *"Builder and Viewer users cannot
 * see or invoke invitation controls"* means when a test can only read HTML; and a settled row must
 * offer no action at all, which is *"revoke immediately removes any usable invitation action"*.
 */
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

const PENDING: InvitationResource = {
  id: 'invitation-1',
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: 'user-1',
  expiresAt: '2026-09-21T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-14T11:00:00.000Z',
};

const EXPIRED: InvitationResource = {
  ...PENDING,
  id: 'invitation-2',
  email: 'stale.person@example.test',
  expiresAt: '2026-09-07T12:00:00.000Z',
};

const ACCEPTED: InvitationResource = {
  ...PENDING,
  id: 'invitation-3',
  email: 'joined.person@example.test',
  acceptedAt: '2026-09-13T09:00:00.000Z',
};

const REVOKED: InvitationResource = {
  ...PENDING,
  id: 'invitation-4',
  email: 'dropped.person@example.test',
  revokedAt: '2026-09-13T10:00:00.000Z',
};

const OWNER_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

const noop = () => undefined;

function table(
  state: InvitationsTableState,
  capability: InvitationCapability = OWNER_CAPABILITY,
  busyInvitationId: string | null = null,
  actionProblem: string | null = null,
): string {
  return renderToStaticMarkup(
    <InvitationsTable
      state={state}
      capability={capability}
      busyInvitationId={busyInvitationId}
      actionProblem={actionProblem}
      onResend={noop}
      onRevoke={noop}
    />,
  );
}

const allFour: InvitationsTableState = {
  kind: 'ready',
  invitations: [PENDING, EXPIRED, ACCEPTED, REVOKED],
  nowMs: NOW,
};

describe('InvitationsTable async states', () => {
  it('says it is loading rather than rendering an empty list it has not read', () => {
    const html = table({ kind: 'loading' });
    expect(html).toContain('Loading invitations…');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<table');
  });

  it('renders a refusal as a refusal, not as a workspace with no invitations', () => {
    // §21 gives `invitations` to Owner and Admin only, so the list route answers a Builder or a
    // Viewer `403`. "No invitations have been sent" would be a claim that response never made.
    const html = table({ kind: 'refused' }, NO_INVITATION_CAPABILITY);
    expect(html).toContain('not part of your role');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('No invitations have been sent');
  });

  it('renders a failed read with the wording it was given', () => {
    const html = table({ kind: 'failed', message: 'The connection was reset.' });
    expect(html).toContain('The connection was reset.');
    expect(html).toContain('role="alert"');
  });

  it('renders a workspace that has sent none as empty', () => {
    expect(table({ kind: 'ready', invitations: [], nowMs: NOW })).toContain(
      'No invitations have been sent',
    );
  });

  it('shows a failed resend or revoke above the table', () => {
    const html = table(allFour, OWNER_CAPABILITY, null, 'No invitation exists in this workspace.');
    expect(html).toContain('No invitation exists in this workspace.');
    expect(html).toContain('role="alert"');
  });
});

describe('InvitationsTable states per row', () => {
  it('shows every field #186 asks for: invitee, role and state', () => {
    const html = table(allFour);
    expect(html).toContain('new.person@example.test');
    expect(html).toContain('Builder');
    expect(html).toContain('Pending');
    expect(html).toContain('Expired');
    expect(html).toContain('Accepted');
    expect(html).toContain('Revoked');
  });

  it('derives all four states from the timestamps, with no state field on the wire', () => {
    // One row per state, and each one named exactly once in the Status column.
    const html = table(allFour);
    for (const state of ['Pending', 'Expired', 'Accepted', 'Revoked']) {
      expect(html.match(new RegExp(`>${state}<`, 'gu'))).toHaveLength(1);
    }
  });

  it('prints the one timestamp each state is about, as a date', () => {
    const html = table(allFour);
    expect(html).toContain('Expires ');
    expect(html).toContain('Expired ');
    expect(html).toContain('Accepted ');
    expect(html).toContain('Revoked ');
    expect(html).not.toContain('2026-09-21T12:00:00.000Z');
  });

  it('offers Resend and Revoke on a pending row, each naming its invitee', () => {
    const html = table(allFour);
    expect(html).toContain('aria-label="Resend the invitation for new.person@example.test"');
    expect(html).toContain('aria-label="Revoke the invitation for new.person@example.test"');
  });

  it('offers both actions on an expired row, because resend mints a fresh expiry', () => {
    const html = table(allFour);
    expect(html).toContain('aria-label="Resend the invitation for stale.person@example.test"');
    expect(html).toContain('aria-label="Revoke the invitation for stale.person@example.test"');
  });

  it('offers no action on an accepted or revoked row, and says why', () => {
    // "Revoke immediately removes any usable invitation action", read off the markup.
    const html = table(allFour);
    expect(html).not.toContain('joined.person@example.test"');
    expect(html).not.toContain('for joined.person@example.test');
    expect(html).not.toContain('for dropped.person@example.test');
    expect(html).toContain('Manage this person in the members table above.');
    expect(html).toContain('Send a new invitation if they still need access.');
  });

  it('makes a row inert while its own mutation is in flight, and only that row', () => {
    const html = table(allFour, OWNER_CAPABILITY, PENDING.id);
    // Two controls on the busy row, and nothing else disabled: the expired row keeps both of its.
    expect(html.match(/disabled/gu)).toHaveLength(2);
  });

  it('withholds each action on its own grant rather than on the pair', () => {
    const revokeOnly: InvitationCapability = { ...OWNER_CAPABILITY, canResendInvitation: false };
    const html = table(allFour, revokeOnly);
    expect(html).not.toContain('aria-label="Resend the invitation');
    expect(html).toContain('aria-label="Revoke the invitation for new.person@example.test"');
  });

  it('renders no control and no actions column at all under a Builder or Viewer capability', () => {
    // The whole of "Builder and Viewer users cannot see or invoke invitation controls", asserted
    // over the markup rather than over a role name. Deleting either capability guard fails here.
    const html = table(allFour, NO_INVITATION_CAPABILITY);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Actions');
    // And no per-row explanation either: the section is already a refusal for them.
    expect(html).not.toContain('members table above');
  });

  it('gives the table a horizontal scroll container, so the actions column stays reachable', () => {
    // The same measured defect `members-table.test.tsx` records: four columns with an address among
    // them do not fit a phone, and the actions column is last. A static render cannot measure a
    // layout, so what is asserted is the container's presence and its position.
    expect(table(allFour)).toContain('<div class="overflow-x-auto"><table');
  });

  it('carries no token anywhere, because no field of a list row can hold one', () => {
    // Structural: `InvitationResource` has no token field and the list schema is `.strict()`. This
    // pins the consequence — the table is not, and must not become, a place a secret is rendered.
    expect(table(allFour)).not.toContain('token');
    expect(table(allFour)).not.toContain('accept-invitation');
  });
});
