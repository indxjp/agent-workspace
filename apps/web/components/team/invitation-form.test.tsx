import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NO_INVITATION_CAPABILITY } from '../../contracts/invitations';
import { InvitationForm } from './invitation-form';
import {
  EMPTY_INVITATION_DRAFT,
  type InvitationCapability,
  type InvitationDraft,
} from './invitations-model';

/**
 * The invite form — issue #186.
 *
 * Two assertions are load-bearing. The form must not render **at all** without
 * `canCreateInvitation`, which is half of *"Builder and Viewer users cannot see or invoke invitation
 * controls"*. And its role options must be exactly `invitableRoles` — `conferRole`'s own answer,
 * resolved on the server — because an option built from a privilege ordering would offer an Admin
 * the chance to invite a Builder, which `POST /api/invitations` refuses `403`.
 */
const OWNER_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

/** What `server/team/invitation-capability.ts` answers an Admin: no Owner, no Builder. */
const ADMIN_CAPABILITY: InvitationCapability = {
  ...OWNER_CAPABILITY,
  invitableRoles: ['admin', 'viewer'],
};

const noop = () => undefined;

function form(
  capability: InvitationCapability = OWNER_CAPABILITY,
  draft: InvitationDraft = EMPTY_INVITATION_DRAFT,
  sending = false,
  problem: string | null = null,
): string {
  return renderToStaticMarkup(
    <InvitationForm
      capability={capability}
      draft={draft}
      sending={sending}
      problem={problem}
      onChange={noop}
      onSubmit={noop}
    />,
  );
}

describe('InvitationForm', () => {
  it('renders nothing at all for a caller the server will not let create one', () => {
    expect(form(NO_INVITATION_CAPABILITY)).toBe('');
  });

  it('renders nothing for a Builder, whose conferral set is non-empty but whose grant is not', () => {
    // `conferRole` is reflexive, so a Builder's invitable set is `['builder']`
    // (`server/team/invitation-capability.test.ts` records why). The gate is the §21 grant, and this
    // is the test that proves the form is not gated on the set instead.
    const builder: InvitationCapability = {
      ...NO_INVITATION_CAPABILITY,
      invitableRoles: ['builder'],
    };
    expect(form(builder)).toBe('');
  });

  it('labels both fields, which the accessibility floor requires of every control', () => {
    const html = form();
    expect(html).toMatch(/<label[^>]*for="invite-email"/u);
    expect(html).toMatch(/<label[^>]*for="invite-role"/u);
    expect(html).toContain('id="invite-email"');
    expect(html).toContain('id="invite-role"');
  });

  it('offers only the roles the server said this caller may invite', () => {
    const html = form(ADMIN_CAPABILITY);
    expect(html).toMatch(/<option value="admin"[^>]*>Admin<\/option>/u);
    expect(html).toContain('<option value="viewer">Viewer</option>');
    expect(html).not.toContain('<option value="owner"');
    expect(html).not.toContain('<option value="builder"');
  });

  it('opens on no role at all, so the most privileged one is never the default', () => {
    // `invitableRoles` is `conferrableRolesFor`'s filter of `['owner', 'admin', 'builder', 'viewer']`
    // in that order, so pre-selecting its first entry would open an Owner's form on **Owner** — an
    // address typed into an otherwise untouched form would be granted the workspace. The disabled
    // placeholder is what is selected instead, and no role is.
    const html = form(OWNER_CAPABILITY);
    expect(html).toContain('<option value="" disabled="" selected="">Choose a role</option>');
    expect(html).not.toMatch(/<option value="(?:owner|admin|builder|viewer)"[^>]*selected/u);
  });

  it('cannot be submitted on an address alone, while no role has been chosen', () => {
    // The other half of the same decision: the placeholder maps back to `role: null`
    // (`roleFrom`), which `invitationRequestFrom` refuses, so the control stays inert rather than
    // sending a grant nobody picked.
    const html = form(OWNER_CAPABILITY, { email: 'new.person@example.test', role: null });
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/u);
  });

  it('cannot be submitted from a fresh form', () => {
    // An empty address is not a request, and the disabled control says so before the round trip.
    expect(form()).toMatch(/<button[^>]*type="submit"[^>]*disabled/u);
  });

  it('can be submitted once an address and a role are present', () => {
    const html = form(OWNER_CAPABILITY, { email: 'new.person@example.test', role: 'builder' });
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/u);
    expect(html).toContain('Send invitation');
  });

  it('goes inert and says so while the request is in flight', () => {
    const html = form(
      OWNER_CAPABILITY,
      { email: 'new.person@example.test', role: 'builder' },
      true,
    );
    expect(html).toContain('Sending…');
    // The address field, the role select and the submit button — plus the placeholder option, which
    // is disabled whatever the form is doing.
    expect(html.match(/disabled/gu)).toHaveLength(4);
  });

  it('shows a failed create in the server’s own words', () => {
    const html = form(
      OWNER_CAPABILITY,
      { email: 'new.person@example.test', role: 'builder' },
      false,
      'new.person@example.test already has a pending invitation to this workspace. Resend it, or revoke it before sending a new one.',
    );
    expect(html).toContain('already has a pending invitation');
    expect(html).toContain('role="alert"');
  });

  it('says the deployment sends no email, which is declared gap G-10', () => {
    expect(form()).toContain('They receive no email.');
  });
});
