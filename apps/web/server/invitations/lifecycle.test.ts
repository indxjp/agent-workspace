import { describe, expect, it } from 'vitest';

import { conferredBy } from '../rbac/conferral';
import { createMemoryDirectory } from '../rbac/memory-directory';

const TARGET = 'workspace-a';
const OTHER = 'workspace-b';

function identity(email: string) {
  return { email, issuer: 'https://issuer.example.test', subject: `subject:${email}` };
}

function ids(): () => string {
  let value = 0;
  return () => `id-${String((value += 1))}`;
}

describe('invitation lifecycle contract', () => {
  it('stores no presented token in listable state and collapses id, token, and email mismatches', async () => {
    const directory = createMemoryDirectory({ newId: ids() });
    const scoped = directory.forWorkspace(TARGET);
    const created = await scoped.createInvitation({
      email: ' Invitee@Example.test ',
      role: conferredBy('owner', 'viewer', 'invitation lifecycle test'),
      invitedBy: null,
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('setup failed');

    const listed = await scoped.listInvitations();
    expect(listed).toEqual([
      expect.objectContaining({ id: created.invitation.id, email: 'invitee@example.test' }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const randomId = await directory.acceptInvitation(
      'id-that-never-existed',
      created.token,
      identity('invitee@example.test'),
    );
    const wrongToken = await directory.acceptInvitation(
      created.invitation.id,
      'not-the-token',
      identity('invitee@example.test'),
    );
    const wrongEmail = await directory.acceptInvitation(
      created.invitation.id,
      created.token,
      identity('attacker@example.test'),
    );
    expect(randomId).toEqual({ kind: 'invalid' });
    expect(wrongToken).toEqual(randomId);
    expect(wrongEmail).toEqual(randomId);
  });

  it('lets exactly one concurrent duplicate create survive', async () => {
    const directory = createMemoryDirectory({ newId: ids() });
    const scoped = directory.forWorkspace(TARGET);
    const input = {
      email: 'same@example.test',
      role: conferredBy('owner', 'builder', 'invitation concurrency test'),
      invitedBy: null,
    };

    const outcomes = await Promise.all([
      scoped.createInvitation(input),
      scoped.createInvitation({ ...input, email: ' SAME@example.test ' }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['already-invited', 'created']);
    expect(await scoped.listInvitations()).toHaveLength(1);
  });

  it('resend rotates the token, replay is refused, and acceptance creates one membership', async () => {
    const directory = createMemoryDirectory({ newId: ids() });
    const scoped = directory.forWorkspace(TARGET);
    const created = await scoped.createInvitation({
      email: 'new@example.test',
      role: conferredBy('owner', 'builder', 'invitation resend test'),
      invitedBy: null,
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    const resent = await scoped.resendInvitation(created.invitation.id);
    expect(resent.kind).toBe('resent');
    if (resent.kind !== 'resent') throw new Error('resend failed');
    expect(resent.token).not.toBe(created.token);
    expect(
      await directory.acceptInvitation(
        created.invitation.id,
        created.token,
        identity('new@example.test'),
      ),
    ).toEqual({ kind: 'invalid' });

    const accepted = await directory.acceptInvitation(
      created.invitation.id,
      resent.token,
      identity('NEW@example.test'),
    );
    expect(accepted).toMatchObject({
      kind: 'accepted',
      workspaceId: TARGET,
      membership: { role: 'builder' },
    });
    expect(await scoped.listMemberships()).toHaveLength(1);
    expect(
      await directory.acceptInvitation(
        created.invitation.id,
        resent.token,
        identity('new@example.test'),
      ),
    ).toEqual({ kind: 'already-accepted' });
    expect(await scoped.listMemberships()).toHaveLength(1);
  });

  it('reuses an existing global user, and consumes a token for an existing target member', async () => {
    const directory = createMemoryDirectory({
      newId: ids(),
      users: [
        { email: 'existing@example.test', name: 'Existing', workspaceId: OTHER, role: 'viewer' },
        { email: 'member@example.test', name: 'Member', workspaceId: TARGET, role: 'viewer' },
      ],
    });
    const scoped = directory.forWorkspace(TARGET);

    const existing = await scoped.createInvitation({
      email: 'existing@example.test',
      role: conferredBy('owner', 'admin', 'existing-user invitation test'),
      invitedBy: null,
    });
    if (existing.kind !== 'created') throw new Error('setup failed');
    expect(
      await directory.acceptInvitation(
        existing.invitation.id,
        existing.token,
        identity('existing@example.test'),
      ),
    ).toMatchObject({ kind: 'accepted', membership: { role: 'admin' } });
    expect(
      (await scoped.listUsers()).filter((user) => user.email === 'existing@example.test'),
    ).toHaveLength(1);

    const alreadyMember = await scoped.createInvitation({
      email: 'member@example.test',
      role: conferredBy('owner', 'builder', 'existing-member invitation test'),
      invitedBy: null,
    });
    if (alreadyMember.kind !== 'created') throw new Error('setup failed');
    expect(
      await directory.acceptInvitation(
        alreadyMember.invitation.id,
        alreadyMember.token,
        identity('member@example.test'),
      ),
    ).toMatchObject({ kind: 'already-member', workspaceId: TARGET });
    expect(
      await directory.acceptInvitation(
        alreadyMember.invitation.id,
        alreadyMember.token,
        identity('member@example.test'),
      ),
    ).toEqual({ kind: 'already-accepted' });
  });

  it('makes expiry and revoke terminal, and never accepts into an archived workspace', async () => {
    let current = new Date('2026-09-12T00:00:00.000Z');
    const directory = createMemoryDirectory({
      now: () => current,
      newId: ids(),
      workspaces: [
        { id: TARGET, slug: 'a', name: 'A' },
        {
          id: OTHER,
          slug: 'b',
          name: 'B',
          archivedAt: '2026-09-11T00:00:00.000Z',
        },
      ],
    });

    const expired = await directory.forWorkspace(TARGET).createInvitation({
      email: 'expired@example.test',
      role: conferredBy('owner', 'viewer', 'expired invitation test'),
      invitedBy: null,
    });
    if (expired.kind !== 'created') throw new Error('setup failed');
    current = new Date('2026-09-20T00:00:00.000Z');
    expect(
      await directory.acceptInvitation(
        expired.invitation.id,
        expired.token,
        identity('expired@example.test'),
      ),
    ).toEqual({ kind: 'expired' });

    const revoked = await directory.forWorkspace(TARGET).createInvitation({
      email: 'revoked@example.test',
      role: conferredBy('owner', 'viewer', 'revoked invitation test'),
      invitedBy: null,
    });
    if (revoked.kind !== 'created') throw new Error('setup failed');
    expect(
      (await directory.forWorkspace(TARGET).revokeInvitation(revoked.invitation.id)).kind,
    ).toBe('revoked');
    expect(
      await directory.acceptInvitation(
        revoked.invitation.id,
        revoked.token,
        identity('revoked@example.test'),
      ),
    ).toEqual({ kind: 'revoked' });

    const archived = await directory.forWorkspace(OTHER).createInvitation({
      email: 'archived@example.test',
      role: conferredBy('owner', 'viewer', 'archived invitation test'),
      invitedBy: null,
    });
    if (archived.kind !== 'created') throw new Error('setup failed');
    expect(
      await directory.acceptInvitation(
        archived.invitation.id,
        archived.token,
        identity('archived@example.test'),
      ),
    ).toEqual({ kind: 'invalid' });
    expect(await directory.forWorkspace(OTHER).listMemberships()).toHaveLength(0);
  });
});
