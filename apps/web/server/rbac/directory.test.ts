/**
 * The directory port's contract, over the in-memory implementation.
 *
 * This suite is written against {@link DirectoryRoot} and never against the implementation's
 * internals. `postgres-directory.test.ts` and `postgres-invitations.test.ts` exercise the durable
 * adapter against the same contract; this file keeps the fast in-memory half.
 *
 * Each assertion below corresponds to a constraint the database already enforces, so the two
 * implementations answer the same question about the same input: `users_email_lowercase`,
 * `api_keys_workspace_name_key`, the unique membership per workspace, and §25's rule that one
 * workspace's rows are invisible from another's.
 */
import { describe, expect, it } from 'vitest';

import { conferredBy, type ConferredRole } from './conferral';
import { listMemberships } from './handlers';
import { createMemoryDirectory } from './memory-directory';
import type { Role } from './roles';

/**
 * A role an Owner may confer, for the fixture rows below.
 *
 * The directory port takes a `ConferredRole` rather than a `Role` — the type-level half of
 * `conferral.ts`'s rule, and what makes a route that never asked *"may this caller confer this
 * role?"* a compile error rather than a review comment. A test that writes a role into a row
 * therefore has to say who is conferring it. An Owner may confer all four; `conferredBy` runs the
 * same comparison every route runs and throws if that ever stops being true.
 */
function asOwner(role: Role): ConferredRole {
  return conferredBy('owner', role, 'the fixture in this test file');
}

const WS = 'workspace-a';
const OTHER = 'workspace-b';

function seeded(): ReturnType<typeof createMemoryDirectory> {
  return createMemoryDirectory({
    users: [
      { email: 'owner@example.test', name: 'Owner', workspaceId: WS, role: 'owner' },
      { email: 'admin@example.test', name: 'Admin', workspaceId: WS, role: 'admin' },
      { email: 'elsewhere@example.test', name: 'Elsewhere', workspaceId: OTHER, role: 'owner' },
    ],
  });
}

describe('users and memberships', () => {
  it('lists only the callers workspace — spec §25', async () => {
    const directory = seeded();
    const here = await directory.forWorkspace(WS).listUsers();
    expect(here.map((user) => user.email)).toEqual(['admin@example.test', 'owner@example.test']);
    const there = await directory.forWorkspace(OTHER).listUsers();
    expect(there.map((user) => user.email)).toEqual(['elsewhere@example.test']);
  });

  it('stores an email lower-cased, as users_email_lowercase requires', async () => {
    const directory = seeded();
    const outcome = await directory
      .forWorkspace(WS)
      .createUser({ email: '  MiXeD@Example.TEST ', name: 'Mixed', role: asOwner('viewer') });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.user.email).toBe('mixed@example.test');
    // …and the duplicate is refused on the normalised form, not on the spelling.
    const again = await directory
      .forWorkspace(WS)
      .createUser({ email: 'MIXED@EXAMPLE.TEST', name: 'Mixed', role: asOwner('viewer') });
    expect(again.kind).toBe('email-taken');
  });

  it('refuses a membership for a user that does not exist, and a second one for a member', async () => {
    const directory = seeded();
    const workspace = directory.forWorkspace(WS);
    expect(
      (await workspace.createMembership({ email: 'nobody@example.test', role: asOwner('viewer') }))
        .kind,
    ).toBe('no-such-user');
    expect(
      (await workspace.createMembership({ email: 'admin@example.test', role: asOwner('viewer') }))
        .kind,
    ).toBe('already-a-member');
    // A user of another workspace can be added to this one: the user row is global, the
    // membership is per workspace (spec §27).
    expect(
      (
        await workspace.createMembership({
          email: 'elsewhere@example.test',
          role: asOwner('builder'),
        })
      ).kind,
    ).toBe('created');
  });

  it('refuses to demote or remove the last Owner', async () => {
    const directory = seeded();
    const workspace = directory.forWorkspace(WS);
    const memberships = await workspace.listMemberships();
    const owner = memberships.find((row) => row.role === 'owner');
    if (owner === undefined) throw new Error('the seed did not create an Owner');

    expect((await workspace.changeMembershipRole(owner.id, asOwner('admin'))).kind).toBe(
      'last-owner',
    );
    expect((await workspace.deleteMembership(owner.id)).kind).toBe('last-owner');

    // With a second Owner it is allowed — which is what proves the refusal above is about the
    // count and not about Owners in general.
    const promoted = memberships.find((row) => row.role === 'admin');
    if (promoted === undefined) throw new Error('the seed did not create an Admin');
    expect((await workspace.changeMembershipRole(promoted.id, asOwner('owner'))).kind).toBe(
      'changed',
    );
    expect((await workspace.changeMembershipRole(owner.id, asOwner('admin'))).kind).toBe('changed');
  });

  it('assigns every seeded membership a distinct principal id', async () => {
    const memberships = await seeded().forWorkspace(WS).listMemberships();
    expect(new Set(memberships.map((membership) => membership.principalId)).size).toBe(
      memberships.length,
    );
  });

  it('cannot reach another workspace’s membership by id', async () => {
    const directory = seeded();
    const theirs = await directory.forWorkspace(OTHER).listMemberships();
    const target = theirs[0];
    if (target === undefined) throw new Error('the other workspace has no membership');
    // Same id, wrong tenant: "no such membership", not "forbidden" and not a successful write.
    expect((await directory.forWorkspace(WS).deleteMembership(target.id)).kind).toBe(
      'no-such-membership',
    );
    expect(
      (await directory.forWorkspace(WS).changeMembershipRole(target.id, asOwner('viewer'))).kind,
    ).toBe('no-such-membership');
  });

  it('resolves a role only when a membership row joins the user to the workspace', async () => {
    const directory = seeded();
    expect(await directory.resolveRole('owner@example.test', WS)).toBe('owner');
    expect(await directory.resolveRole('OWNER@EXAMPLE.TEST', WS)).toBe('owner');
    // A real user, the wrong workspace.
    expect(await directory.resolveRole('elsewhere@example.test', WS)).toBeNull();
    // No user at all.
    expect(await directory.resolveRole('nobody@example.test', WS)).toBeNull();
  });
});

// Issue #181: the Team UX (#122) reads members from `GET /api/memberships` alone, so the joined
// `users.name` has to survive all the way into that response body. The assertion below is on the
// whole body rather than on one field, because what the screen depends on is the shape, and it is
// driven through `handlers.listMemberships` rather than the adapter so the route's own mapping is
// covered too.
describe('membership summaries carry the joined user name (issue #181)', () => {
  it('returns the joined user name in the workspace-scoped membership HTTP shape', async () => {
    const createdAt = '2026-01-02T03:04:05.000Z';
    let counter = 0;
    const directory = createMemoryDirectory({
      now: () => new Date(createdAt),
      newId: () => `membership-${String((counter += 1))}`,
      users: [
        // Names that share no substring with their email local part: an implementation that
        // derived a name from the address cannot produce any of these three.
        {
          id: 'user-owner',
          email: 'owner@example.test',
          name: 'Workspace Owner',
          workspaceId: WS,
          role: 'owner',
        },
        {
          id: 'user-admin',
          email: 'admin@example.test',
          name: 'Workspace Admin',
          workspaceId: WS,
          role: 'admin',
        },
        {
          id: 'user-foreign',
          email: 'elsewhere@example.test',
          name: 'Foreign Tenant Member',
          workspaceId: OTHER,
          role: 'owner',
        },
      ],
    });

    const result = await listMemberships(directory.forWorkspace(WS));

    expect(result).toEqual({
      status: 200,
      body: {
        memberships: [
          {
            id: 'membership-2',
            principalId: expect.any(String) as unknown,
            userId: 'user-admin',
            email: 'admin@example.test',
            name: 'Workspace Admin',
            role: 'admin',
            createdAt,
          },
          {
            id: 'membership-1',
            principalId: expect.any(String) as unknown,
            userId: 'user-owner',
            email: 'owner@example.test',
            name: 'Workspace Owner',
            role: 'owner',
            createdAt,
          },
        ],
      },
    });

    // §25, restated for the field this change adds: a name leaks a tenant's roster just as an
    // email does, so both halves of the foreign member are scanned for in the serialised body.
    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain('elsewhere@example.test');
    expect(serialised).not.toContain('Foreign Tenant Member');
  });
});

describe('api keys', () => {
  it('refuses a second key with the same name in one workspace, and allows it in another', async () => {
    const directory = seeded();
    expect(
      (
        await directory
          .forWorkspace(WS)
          .createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null })
      ).kind,
    ).toBe('created');
    expect(
      (
        await directory
          .forWorkspace(WS)
          .createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null })
      ).kind,
    ).toBe('name-taken');
    expect(
      (
        await directory
          .forWorkspace(OTHER)
          .createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null })
      ).kind,
    ).toBe('created');
  });

  it('cannot read or revoke another workspace’s key', async () => {
    const directory = seeded();
    const created = await directory
      .forWorkspace(OTHER)
      .createApiKey({ name: 'theirs', role: asOwner('admin'), expiresAt: null });
    if (created.kind !== 'created') throw new Error('creation failed');
    expect(await directory.forWorkspace(WS).readStoredApiKey(created.key.id)).toBeNull();
    expect((await directory.forWorkspace(WS).revokeApiKey(created.key.id)).kind).toBe(
      'no-such-key',
    );
    expect((await directory.forWorkspace(WS).listApiKeys()).length).toBe(0);
  });

  it('revokes by writing a timestamp, and says so a second time rather than failing', async () => {
    const directory = seeded();
    const workspace = directory.forWorkspace(WS);
    const created = await workspace.createApiKey({
      name: 'k',
      role: asOwner('viewer'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error('creation failed');
    const first = await workspace.revokeApiKey(created.key.id);
    expect(first.kind).toBe('revoked');
    const stored = await workspace.readStoredApiKey(created.key.id);
    expect(stored, 'revocation deleted the row instead of writing revoked_at').not.toBeNull();
    expect(stored?.revokedAt).not.toBeNull();
    expect((await workspace.revokeApiKey(created.key.id)).kind).toBe('already-revoked');
  });
});

// Issue #118: an OIDC identity resolves to a user, and a user's CURRENT memberships are read
// across every workspace, not one. Both are new to `DirectoryRoot` and must hold on the
// PostgreSQL implementation too, which is why they are written against the port and not the
// in-memory internals — the same rule the rest of this file follows.
describe('OIDC identity mapping and cross-workspace memberships (issue #118)', () => {
  it('finds a user by email, case-insensitively, and null for nobody', async () => {
    const directory = seeded();
    expect(await directory.findUserByEmail('OWNER@example.test')).toMatchObject({
      email: 'owner@example.test',
    });
    expect(await directory.findUserByEmail('nobody@example.test')).toBeNull();
  });

  it('binds an (issuer, subject) pair to a user, and finds it back', async () => {
    const directory = seeded();
    const owner = await directory.findUserByEmail('owner@example.test');
    if (owner === null) throw new Error('seed did not create the owner');

    expect(await directory.findIdentity('https://idp.example', 'sub-1')).toBeNull();
    await directory.linkIdentity('https://idp.example', 'sub-1', owner.id);
    expect(await directory.findIdentity('https://idp.example', 'sub-1')).toEqual({
      userId: owner.id,
      email: owner.email,
    });
    // A different issuer, or a different subject, is a different binding — the pair is the key,
    // not either half alone.
    expect(await directory.findIdentity('https://other-idp.example', 'sub-1')).toBeNull();
    expect(await directory.findIdentity('https://idp.example', 'sub-2')).toBeNull();
  });

  it('binding the same pair to the same user twice succeeds silently — a replayed callback', async () => {
    const directory = seeded();
    const owner = await directory.findUserByEmail('owner@example.test');
    if (owner === null) throw new Error('seed did not create the owner');
    await directory.linkIdentity('https://idp.example', 'sub-replay', owner.id);
    await expect(
      directory.linkIdentity('https://idp.example', 'sub-replay', owner.id),
    ).resolves.toBeUndefined();
    expect(await directory.findIdentity('https://idp.example', 'sub-replay')).toEqual({
      userId: owner.id,
      email: owner.email,
    });
  });

  it('refuses to rebind an existing OIDC identity to a different user', async () => {
    const directory = seeded();
    const owner = await directory.findUserByEmail('owner@example.test');
    const admin = await directory.findUserByEmail('admin@example.test');
    if (owner === null || admin === null) throw new Error('seed did not create both users');

    await directory.linkIdentity('https://idp.example', 'sub-conflict', owner.id);
    await expect(
      directory.linkIdentity('https://idp.example', 'sub-conflict', admin.id),
    ).rejects.toThrow('OIDC identity is already bound to a different user');
    expect(await directory.findIdentity('https://idp.example', 'sub-conflict')).toEqual({
      userId: owner.id,
      email: owner.email,
    });
  });

  it('lists every CURRENT membership a user holds, across workspaces, and none once removed', async () => {
    const directory = createMemoryDirectory({
      workspaces: [
        { id: WS, slug: 'acme', name: 'Acme' },
        { id: OTHER, slug: 'other-co', name: 'Other Co' },
      ],
      users: [
        { email: 'multi@example.test', name: 'Multi', workspaceId: WS, role: 'admin' },
        {
          email: 'owner-other@example.test',
          name: 'Owner Other',
          workspaceId: OTHER,
          role: 'owner',
        },
      ],
    });
    const multi = await directory.findUserByEmail('multi@example.test');
    if (multi === null) throw new Error('seed did not create multi@example.test');

    // Not a member of OTHER yet: one membership only, named with the real slug and name — not
    // the workspace id, which is what a caller minting a session from this needs.
    const originalMembership = (await directory.forWorkspace(WS).listMemberships()).find(
      (membership) => membership.userId === multi.id,
    );
    if (originalMembership === undefined) throw new Error('original membership not found');
    expect(await directory.membershipsForUser(multi.id)).toEqual([
      {
        principalId: originalMembership.principalId,
        workspaceId: WS,
        workspaceSlug: 'acme',
        workspaceName: 'Acme',
        role: 'admin',
      },
    ]);

    const added = await directory
      .forWorkspace(OTHER)
      .createMembership({ email: 'multi@example.test', role: asOwner('viewer') });
    expect(added.kind).toBe('created');
    if (added.kind !== 'created') throw new Error('membership was not created');

    const both = await directory.membershipsForUser(multi.id);
    expect(both).toEqual(
      expect.arrayContaining([
        {
          principalId: originalMembership.principalId,
          workspaceId: WS,
          workspaceSlug: 'acme',
          workspaceName: 'Acme',
          role: 'admin',
        },
        {
          principalId: added.membership.principalId,
          workspaceId: OTHER,
          workspaceSlug: 'other-co',
          workspaceName: 'Other Co',
          role: 'viewer',
        },
      ]),
    );
    expect(both).toHaveLength(2);

    // Removed from one workspace: that workspace stops appearing, immediately — issue #118's
    // "role changes/removal take effect on the next request", applied to membership itself.
    const membershipInOther = (await directory.forWorkspace(OTHER).listMemberships()).find(
      (row) => row.email === 'multi@example.test',
    );
    if (membershipInOther === undefined) throw new Error('membership not found');
    await directory.forWorkspace(OTHER).deleteMembership(membershipInOther.id);
    expect(await directory.membershipsForUser(multi.id)).toEqual([
      {
        principalId: originalMembership.principalId,
        workspaceId: WS,
        workspaceSlug: 'acme',
        workspaceName: 'Acme',
        role: 'admin',
      },
    ]);
  });

  it('a user with no membership at all gets the empty list, not an error', async () => {
    const directory = seeded();
    const outcome = await directory
      .forWorkspace(WS)
      .createUser({ email: 'bare@example.test', name: 'Bare', role: asOwner('viewer') });
    if (outcome.kind !== 'created') throw new Error('unreachable');
    await directory.forWorkspace(WS).deleteMembership(outcome.membership.id);
    expect(await directory.membershipsForUser(outcome.user.id)).toEqual([]);
  });
});
