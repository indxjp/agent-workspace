import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NO_MEMBERSHIP_CAPABILITY } from '../../contracts/team';
import { MembersTable, type MembersTableState } from './members-table';
import type { MembershipCapability, MembershipResource } from './model';

/**
 * The members table, rendered one state at a time — issue #185.
 *
 * This repository has no jsdom and no Testing Library, so a component test is one
 * `renderToStaticMarkup` pass with no effects and no events. Every state below is therefore a prop,
 * and the load-bearing assertions are the negative ones: a capability that denies must produce no
 * `<select>` and no Remove button **anywhere** in the markup, which is what "Builder and Viewer
 * users do not see unauthorized controls" means when a test can only read HTML.
 */
const OWNER: MembershipResource = {
  id: 'membership-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  email: 'aya.ito@example.test',
  name: 'Aya Ito',
  role: 'owner',
  createdAt: '2026-09-12T00:00:00.000Z',
};

const ADMIN: MembershipResource = {
  id: 'membership-2',
  principalId: '22222222-2222-4222-8222-222222222222',
  userId: 'user-2',
  email: 'kenji.sato@example.test',
  name: 'Kenji Sato',
  role: 'admin',
  createdAt: '2026-09-13T09:15:00.000Z',
};

const OWNER_CAPABILITY: MembershipCapability = {
  canListMembers: true,
  canChangeRole: true,
  canRemoveMember: true,
  conferrableRoles: ['owner', 'admin', 'builder', 'viewer'],
  viewerUserId: 'user-1',
};

/** What a Builder or a Viewer is answered: no list, no controls, no viewer id in the grants. */
const REFUSED_CAPABILITY = NO_MEMBERSHIP_CAPABILITY;

const noop = () => undefined;

function table(
  state: MembersTableState,
  capability: MembershipCapability = OWNER_CAPABILITY,
  busyMembershipId: string | null = null,
  roleProblem: string | null = null,
): string {
  return renderToStaticMarkup(
    <MembersTable
      state={state}
      capability={capability}
      busyMembershipId={busyMembershipId}
      roleProblem={roleProblem}
      onChangeRole={noop}
      onRemove={noop}
    />,
  );
}

describe('MembersTable async states', () => {
  it('says it is loading rather than rendering an empty list it has not read', () => {
    const html = table({ kind: 'loading' });
    expect(html).toContain('Loading members…');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<table');
  });

  it('renders a refusal as a refusal, not as a workspace with no members', () => {
    const html = table({ kind: 'refused' }, REFUSED_CAPABILITY);
    expect(html).toContain('not part of your role');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('no members yet');
  });

  it('renders a failed read with the wording it was given', () => {
    const html = table({ kind: 'failed', message: 'The connection was reset.' });
    expect(html).toContain('The connection was reset.');
    expect(html).toContain('role="alert"');
  });

  it('renders an empty workspace as empty', () => {
    expect(table({ kind: 'ready', members: [] })).toContain('no members yet');
  });
});

describe('MembersTable rows', () => {
  const ready: MembersTableState = { kind: 'ready', members: [OWNER, ADMIN] };

  it('shows every field #185 asks for: name, address, role and join date', () => {
    const html = table(ready);
    expect(html).toContain('Aya Ito');
    expect(html).toContain('aya.ito@example.test');
    expect(html).toContain('Owner');
    expect(html).toContain('Kenji Sato');
    expect(html).toContain('Admin');
    // The join timestamp is rendered as a date rather than as the raw ISO string.
    expect(html).not.toContain('2026-09-12T00:00:00.000Z');
  });

  it('marks the current user’s own row, and only that row', () => {
    expect(table(ready).match(/>You</gu)).toHaveLength(1);
  });

  it('offers no demotion and no removal on the sole Owner’s row, and says why', () => {
    const html = table({ kind: 'ready', members: [OWNER] });
    expect(html).not.toContain('<select');
    expect(html).not.toContain('aria-label="Remove Aya Ito"');
    expect(html).toContain('Last Owner');
  });

  it('offers the other member a role control naming them, and a Remove naming them', () => {
    const html = table(ready);
    expect(html).toContain('aria-label="Role for Kenji Sato"');
    expect(html).toContain('aria-label="Remove Kenji Sato"');
    // The Owner's own row still has neither, because the workspace has only one Owner.
    expect(html).not.toContain('aria-label="Role for Aya Ito"');
  });

  it('offers only the roles the server said this caller may confer', () => {
    const adminCapability: MembershipCapability = {
      ...OWNER_CAPABILITY,
      conferrableRoles: ['admin', 'viewer'],
      viewerUserId: 'user-2',
    };
    const html = table(ready, adminCapability);
    // An Admin may not confer Owner or Builder (`conferral.ts`), so neither appears as an option on
    // the row they may re-role. "Owner" still appears as the first row's rendered role.
    expect(html).toContain('<option value="viewer">Viewer</option>');
    expect(html).not.toContain('<option value="owner">Owner</option>');
    expect(html).not.toContain('<option value="builder">Builder</option>');
  });

  it('does not tell an Admin to promote someone to Owner, which no control here can do', () => {
    const adminCapability: MembershipCapability = {
      ...OWNER_CAPABILITY,
      conferrableRoles: ['admin', 'viewer'],
      viewerUserId: 'user-2',
    };
    // Same list, same sole Owner: the row still withholds both controls, but the way out it names
    // has to be one this caller can take, and an Admin's conferral set has no `owner` in it.
    const html = table(ready, adminCapability);
    expect(html).toContain('Last Owner');
    expect(html).toContain('Only an Owner can promote another member to Owner');
    expect(html).not.toContain('Promote another member to Owner before');
  });

  it('makes a row inert while its own mutation is in flight', () => {
    const html = table(ready, OWNER_CAPABILITY, ADMIN.id);
    expect(html.match(/disabled/gu)).toHaveLength(2);
  });

  it('shows a failed role change above the table', () => {
    const html = table(ready, OWNER_CAPABILITY, null, 'This is the workspace’s last Owner.');
    expect(html).toContain('This is the workspace’s last Owner.');
    expect(html).toContain('role="alert"');
  });

  it('gives the table a horizontal scroll container, so the actions column stays reachable', () => {
    // Four columns — one of them an address — do not fit a 390–412px viewport, and the actions
    // column is last. Without a scroll container the table overflows the card and the layout
    // viewport instead, putting Remove off-screen with nothing able to bring it back: measured at
    // the Pixel 7 viewport, a 519px table inside a 348px card, the button at x 459–536, and
    // `tests/browser/team-members.spec.mjs`'s mobile click retrying until it timed out.
    //
    // A static render cannot measure layout (this repository has no jsdom), so what is asserted
    // here is the container's presence and its position — immediately around the table, inside the
    // card, so the card's border and radius stay put while the table scrolls. The behaviour itself
    // is owned by the browser spec's mobile project.
    expect(table(ready)).toContain('<div class="overflow-x-auto"><table');
  });

  it('renders no control at all under a Builder or Viewer capability', () => {
    // The whole of "Builder and Viewer users do not see unauthorized controls", asserted over the
    // markup rather than over a role name. Deleting either capability guard fails exactly here.
    const html = table(ready, REFUSED_CAPABILITY);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Actions');
  });
});
