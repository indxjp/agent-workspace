/**
 * The RBAC directory conformance suite — **one suite, every implementation of the port**.
 *
 * Written against `DirectoryRoot` (the port the RBAC and invitation routes hold), not against
 * an implementation, and exported as {@link describeDirectoryConformance}. `directory.test.ts`
 * runs it against:
 *
 *   1. `createMemoryDirectory()` — no database, always;
 *   2. `createPostgresDirectory()` over the durable repository and a **real PostgreSQL**, whenever
 *      `TEST_DATABASE_URL` names one.
 *
 * It holds the storage contract only — what each method stores, refuses, returns and in what
 * order, and §25's rule that one workspace's rows are invisible from another's. Who may call which
 * method is policy (`decide.ts`, `conferral.ts`) and is not tested here.
 *
 * Presented keys and invitation tokens never reach test output: every "the secret is not in this"
 * check compares a boolean.
 */
import { describe, expect, it } from 'vitest';

import type { MembershipSummary, WorkspaceDirectory } from './directory';
import { asOwner, type MakeDirectoryFixture } from './directory.test-support';

const ABSENT = '55555555-5555-4555-8555-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HOUR = 60 * 60 * 1000;

type Created<Outcome> = Extract<Outcome, { readonly kind: 'created' }>;

function isCreated<Outcome extends { readonly kind: string }>(
  outcome: Outcome,
): outcome is Created<Outcome> {
  return outcome.kind === 'created';
}

/** The `created` arm of a create outcome, or a thrown error naming the arm that came back. */
export function created<Outcome extends { readonly kind: string }>(
  outcome: Outcome,
): Created<Outcome> {
  if (!isCreated(outcome)) throw new Error(`expected created, got "${outcome.kind}"`);
  return outcome;
}

export async function ownerMembership(
  directory: WorkspaceDirectory,
  email: string,
): Promise<MembershipSummary> {
  const found = (await directory.listMemberships()).find((row) => row.email === email);
  if (found === undefined) throw new Error('the fixture owner has no membership');
  return found;
}

/** The same key with one character of its secret changed. */
export function tampered(presented: string): string {
  const last = presented.at(-1);
  return presented.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** Run the conformance suite against a fixture factory, called once per test. */
export function describeDirectoryConformance(
  label: string,
  makeFixture: MakeDirectoryFixture,
): void {
  describe(label, () => {
    memberships(makeFixture);
    apiKeys(makeFixture);
    invitations(makeFixture);
    identities(makeFixture);
    isolation(makeFixture);
  });
}

/** Users and memberships: creation, listing, role changes, removal and lookup. */
function memberships(makeFixture: MakeDirectoryFixture): void {
  describe('users and memberships', () => {
    membershipCreation(makeFixture);
    membershipChanges(makeFixture);
  });
}

/** Creating users and memberships, and listing them. */
function membershipCreation(makeFixture: MakeDirectoryFixture): void {
  it('creates a user and a membership, normalised, and lists both', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const email = fixture.email('builder');
    const outcome = created(
      await directory.createUser({
        email: `  ${email.toUpperCase()} `,
        name: '  Builder  ',
        role: asOwner('builder'),
      }),
    );
    expect(outcome.user).toMatchObject({ email, name: 'Builder' });
    expect(outcome.membership).toMatchObject({
      userId: outcome.user.id,
      email,
      name: 'Builder',
      role: 'builder',
    });
    expect(outcome.membership.principalId).toMatch(UUID);
    expect(outcome.membership.principalId).not.toBe(outcome.membership.id);
    expect(await directory.listUsers()).toContainEqual(outcome.user);
    expect(await directory.listMemberships()).toContainEqual(outcome.membership);
    await expect(fixture.root.resolveRole(email, fixture.a.id)).resolves.toBe('builder');
  });

  it('answers email-taken for a member of this workspace, on the normalised address', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const before = await directory.listMemberships();
    await expect(
      directory.createUser({
        email: fixture.a.owner.email.toUpperCase(),
        name: 'Again',
        role: asOwner('viewer'),
      }),
    ).resolves.toEqual({ kind: 'email-taken', email: fixture.a.owner.email });
    expect(await directory.listMemberships()).toEqual(before);
  });

  it('reuses the global user row when the address already has an account elsewhere', async () => {
    const fixture = await makeFixture();
    const outcome = created(
      await fixture.root.forWorkspace(fixture.a.id).createUser({
        email: fixture.b.owner.email,
        name: 'A different name',
        role: asOwner('viewer'),
      }),
    );
    expect(outcome.user.id).toBe(fixture.b.owner.userId);
    expect(outcome.user.name).toBe(fixture.b.owner.name);
    expect(outcome.membership.name).toBe(fixture.b.owner.name);
  });

  it('creates a membership only for an existing user who is not yet a member', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const nobody = fixture.email('nobody');
    await expect(
      directory.createMembership({ email: nobody, role: asOwner('viewer') }),
    ).resolves.toEqual({ kind: 'no-such-user', email: nobody });
    await expect(
      directory.createMembership({ email: fixture.a.owner.email, role: asOwner('viewer') }),
    ).resolves.toEqual({ kind: 'already-a-member', email: fixture.a.owner.email });

    const outcome = await directory.createMembership({
      email: ` ${fixture.b.owner.email.toUpperCase()}`,
      role: asOwner('admin'),
    });
    if (outcome.kind !== 'created') throw new Error(outcome.kind);
    expect(outcome.membership).toMatchObject({
      userId: fixture.b.owner.userId,
      email: fixture.b.owner.email,
      name: fixture.b.owner.name,
      role: 'admin',
    });
    expect(await directory.listMemberships()).toContainEqual(outcome.membership);
    await expect(fixture.root.resolveRole(fixture.b.owner.email, fixture.a.id)).resolves.toBe(
      'admin',
    );
  });

  it('lists users and memberships in ascending email order', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    for (const local of ['zulu', 'alpha', 'mike']) {
      created(
        await directory.createUser({
          email: fixture.email(local),
          name: local,
          role: asOwner('viewer'),
        }),
      );
    }
    const emails = (await directory.listUsers()).map((user) => user.email);
    expect(emails).toHaveLength(4);
    expect(emails).toEqual([...emails].sort());
    expect((await directory.listMemberships()).map((row) => row.email)).toEqual(emails);
  });
}

/** Changing, deleting and finding memberships, and resolving a role. */
function membershipChanges(makeFixture: MakeDirectoryFixture): void {
  it('changes a role, and refuses to demote the last Owner', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const owner = await ownerMembership(directory, fixture.a.owner.email);
    await expect(directory.changeMembershipRole(owner.id, asOwner('admin'))).resolves.toEqual({
      kind: 'last-owner',
      id: owner.id,
    });
    await expect(fixture.root.resolveRole(fixture.a.owner.email, fixture.a.id)).resolves.toBe(
      'owner',
    );

    const second = created(
      await directory.createUser({
        email: fixture.email('second'),
        name: 'Second',
        role: asOwner('viewer'),
      }),
    ).membership;
    await expect(directory.changeMembershipRole(second.id, asOwner('owner'))).resolves.toEqual({
      kind: 'changed',
      membership: { ...second, role: 'owner' },
    });
    const demoted = await directory.changeMembershipRole(owner.id, asOwner('admin'));
    expect(demoted).toEqual({ kind: 'changed', membership: { ...owner, role: 'admin' } });
    expect(await directory.listMemberships()).toContainEqual({ ...owner, role: 'admin' });
    await expect(fixture.root.resolveRole(fixture.a.owner.email, fixture.a.id)).resolves.toBe(
      'admin',
    );
  });

  it('deletes a membership, and refuses to delete the last Owner', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const owner = await ownerMembership(directory, fixture.a.owner.email);
    await expect(directory.deleteMembership(owner.id)).resolves.toEqual({
      kind: 'last-owner',
      id: owner.id,
    });

    const email = fixture.email('leaver');
    const leaver = created(
      await directory.createUser({ email, name: 'Leaver', role: asOwner('builder') }),
    ).membership;
    await expect(directory.deleteMembership(leaver.id)).resolves.toEqual({
      kind: 'deleted',
      id: leaver.id,
    });
    expect((await directory.listMemberships()).map((row) => row.id)).toEqual([owner.id]);
    await expect(fixture.root.resolveRole(email, fixture.a.id)).resolves.toBeNull();
    await expect(directory.deleteMembership(leaver.id)).resolves.toEqual({
      kind: 'no-such-membership',
      id: leaver.id,
    });
  });

  it('finds a membership by its principal, and by nothing that is not one live in this workspace', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    const other = fixture.root.forWorkspace(fixture.b.id);
    const member = created(
      await directory.createUser({
        email: fixture.email('principal'),
        name: 'Principal',
        role: asOwner('builder'),
      }),
    ).membership;
    await expect(directory.findMembershipByPrincipal(member.principalId)).resolves.toEqual(member);
    // The membership's own id is not its principal, and another workspace has no such principal.
    await expect(directory.findMembershipByPrincipal(member.id)).resolves.toBeNull();
    await expect(other.findMembershipByPrincipal(member.principalId)).resolves.toBeNull();
    await expect(directory.findMembershipByPrincipal(ABSENT)).resolves.toBeNull();
    await expect(directory.findMembershipByPrincipal('not-a-uuid')).resolves.toBeNull();
    // An API key's principal is a principal, but not a member.
    const { presented } = created(
      await directory.createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null }),
    );
    const identity = await fixture.root.authenticateApiKey(presented, new Date());
    if (identity === null) throw new Error('the fixture key does not authenticate');
    await expect(directory.findMembershipByPrincipal(identity.principalId)).resolves.toBeNull();
    // It follows the member through a role change and out through removal.
    await directory.changeMembershipRole(member.id, asOwner('viewer'));
    await expect(directory.findMembershipByPrincipal(member.principalId)).resolves.toEqual({
      ...member,
      role: 'viewer',
    });
    await directory.deleteMembership(member.id);
    await expect(directory.findMembershipByPrincipal(member.principalId)).resolves.toBeNull();
  });

  it('answers no-such-membership for an id nobody has', async () => {
    const fixture = await makeFixture();
    const directory = fixture.root.forWorkspace(fixture.a.id);
    await expect(directory.changeMembershipRole(ABSENT, asOwner('viewer'))).resolves.toEqual({
      kind: 'no-such-membership',
      id: ABSENT,
    });
    await expect(directory.deleteMembership(ABSENT)).resolves.toEqual({
      kind: 'no-such-membership',
      id: ABSENT,
    });
  });

  it('resolves a role case-insensitively, and null without a joining membership', async () => {
    const fixture = await makeFixture();
    await expect(
      fixture.root.resolveRole(fixture.a.owner.email.toUpperCase(), fixture.a.id),
    ).resolves.toBe('owner');
    await expect(fixture.root.resolveRole(fixture.a.owner.email, fixture.b.id)).resolves.toBeNull();
    await expect(
      fixture.root.resolveRole(fixture.email('nobody'), fixture.a.id),
    ).resolves.toBeNull();
  });
}

/** API keys: hash-only storage, authentication, expiry and revocation. */
function apiKeys(makeFixture: MakeDirectoryFixture): void {
  describe('api keys', () => {
    it('stores only a hash, and authenticates the presented key to its workspace and role', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const outcome = created(
        await directory.createApiKey({ name: ' CI ', role: asOwner('builder'), expiresAt: null }),
      );
      const { key, presented } = outcome;
      expect(Object.keys(key).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'keyPrefix',
        'lastUsedAt',
        'name',
        'revokedAt',
        'role',
      ]);
      expect(key).toMatchObject({
        name: 'CI',
        role: 'builder',
        expiresAt: null,
        revokedAt: null,
      });
      expect(key.keyPrefix).toMatch(/^ak_live_/u);
      expect(presented.startsWith(`${key.keyPrefix}_`)).toBe(true);
      expect(JSON.stringify(key).includes(presented)).toBe(false);

      const stored = await directory.readStoredApiKey(key.id);
      expect(stored).toMatchObject({ id: key.id, workspaceId: fixture.a.id });
      expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(stored).includes(presented.slice(key.keyPrefix.length + 1))).toBe(
        false,
      );

      const identity = await fixture.root.authenticateApiKey(presented, new Date());
      expect(identity).toMatchObject({
        apiKeyId: key.id,
        workspaceId: fixture.a.id,
        role: 'builder',
        label: 'CI',
        actsForPrincipalId: null,
      });
      expect(identity?.principalId).toMatch(UUID);
    });

    it('refuses a presented key that does not parse or does not match', async () => {
      const fixture = await makeFixture();
      const { presented } = created(
        await fixture.root
          .forWorkspace(fixture.a.id)
          .createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null }),
      );
      await expect(fixture.root.authenticateApiKey('not-a-key', new Date())).resolves.toBeNull();
      await expect(
        fixture.root.authenticateApiKey(tampered(presented), new Date()),
      ).resolves.toBeNull();
    });

    it('answers name-taken in one workspace and allows the name in another', async () => {
      const fixture = await makeFixture();
      const input = { name: 'deploy', role: asOwner('viewer'), expiresAt: null };
      created(await fixture.root.forWorkspace(fixture.a.id).createApiKey(input));
      await expect(
        fixture.root.forWorkspace(fixture.a.id).createApiKey({ ...input, name: ' deploy ' }),
      ).resolves.toEqual({ kind: 'name-taken', name: 'deploy' });
      created(await fixture.root.forWorkspace(fixture.b.id).createApiKey(input));
      expect((await fixture.root.forWorkspace(fixture.a.id).listApiKeys()).length).toBe(1);
    });

    it('refuses an expiry in the past, and stops authenticating a key once it expires', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const past = new Date(Date.now() - HOUR).toISOString();
      await expect(
        directory.createApiKey({ name: 'old', role: asOwner('viewer'), expiresAt: past }),
      ).resolves.toEqual({ kind: 'expiry-in-the-past', expiresAt: past });
      await expect(
        directory.createApiKey({ name: 'bad', role: asOwner('viewer'), expiresAt: 'nonsense' }),
      ).resolves.toEqual({ kind: 'expiry-in-the-past', expiresAt: 'nonsense' });

      const expiresAt = new Date(Date.now() + HOUR);
      const { key, presented } = created(
        await directory.createApiKey({
          name: 'short',
          role: asOwner('viewer'),
          expiresAt: expiresAt.toISOString(),
        }),
      );
      expect(key.expiresAt).toBe(expiresAt.toISOString());
      await expect(fixture.root.authenticateApiKey(presented, new Date())).resolves.not.toBeNull();
      await expect(
        fixture.root.authenticateApiKey(presented, new Date(expiresAt.getTime() + 1)),
      ).resolves.toBeNull();
    });

    it('revokes by timestamp, once, and the key stops authenticating', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const { key, presented } = created(
        await directory.createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null }),
      );
      const revoked = await directory.revokeApiKey(key.id);
      if (revoked.kind !== 'revoked') throw new Error(revoked.kind);
      expect(revoked.mcpProjectClientId).toBeNull();
      expect(revoked.key.id).toBe(key.id);
      expect(revoked.key.revokedAt).not.toBeNull();
      await expect(fixture.root.authenticateApiKey(presented, new Date())).resolves.toBeNull();
      await expect(directory.revokeApiKey(key.id)).resolves.toEqual({
        kind: 'already-revoked',
        key: revoked.key,
      });
      expect(await directory.listApiKeys()).toEqual([revoked.key]);
    });

    it('answers not-found for a key id nobody has', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      await expect(directory.revokeApiKey(ABSENT)).resolves.toEqual({
        kind: 'no-such-key',
        id: ABSENT,
      });
      await expect(directory.readStoredApiKey(ABSENT)).resolves.toBeNull();
    });

    it('lists keys in ascending name order', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      for (const name of ['zulu', 'alpha', 'mike']) {
        created(await directory.createApiKey({ name, role: asOwner('viewer'), expiresAt: null }));
      }
      expect((await directory.listApiKeys()).map((key) => key.name)).toEqual([
        'alpha',
        'mike',
        'zulu',
      ]);
    });
  });
}

/** Invitations: creation, resend, acceptance and revocation. */
function invitations(makeFixture: MakeDirectoryFixture): void {
  describe('invitations', () => {
    it('creates a pending invitation without its token, once per pending address', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const email = fixture.email('invitee');
      const { invitation, token } = created(
        await directory.createInvitation({
          email: email.toUpperCase(),
          role: asOwner('builder'),
          invitedBy: fixture.a.owner.userId,
        }),
      );
      expect(invitation).toMatchObject({
        email,
        role: 'builder',
        invitedBy: fixture.a.owner.userId,
        acceptedAt: null,
        revokedAt: null,
      });
      expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(invitation).includes(token)).toBe(false);
      await expect(
        directory.createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
      ).resolves.toEqual({ kind: 'already-invited', email });
      expect(await directory.listInvitations()).toEqual([invitation]);
    });

    it('lists invitations newest first', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const emails = ['first', 'second', 'third'].map((local) => fixture.email(local));
      for (const email of emails) {
        created(
          await directory.createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
        );
      }
      expect((await directory.listInvitations()).map((row) => row.email)).toEqual(
        [...emails].reverse(),
      );
    });

    it('rotates the token on resend, accepts the new one, and then is terminal', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const email = fixture.email('joiner');
      const first = created(
        await directory.createInvitation({ email, role: asOwner('builder'), invitedBy: null }),
      );
      const resent = await directory.resendInvitation(first.invitation.id);
      if (resent.kind !== 'resent') throw new Error(resent.kind);
      expect(resent.token === first.token).toBe(false);
      expect(resent.invitation.id).toBe(first.invitation.id);

      const identity = { email, issuer: 'https://idp.example', subject: fixture.email('sub') };
      await expect(
        fixture.root.acceptInvitation(first.invitation.id, first.token, identity),
      ).resolves.toEqual({ kind: 'invalid' });
      const accepted = await fixture.root.acceptInvitation(
        first.invitation.id,
        resent.token,
        identity,
      );
      if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
      expect(accepted).toMatchObject({
        workspaceId: fixture.a.id,
        workspaceSlug: fixture.a.slug,
        user: { email },
        membership: { email, role: 'builder' },
      });
      expect(await directory.listMemberships()).toContainEqual(accepted.membership);
      await expect(fixture.root.findIdentity(identity.issuer, identity.subject)).resolves.toEqual({
        userId: accepted.user.id,
        email,
      });

      const [row] = await directory.listInvitations();
      expect(row?.acceptedAt).not.toBeNull();
      await expect(
        fixture.root.acceptInvitation(first.invitation.id, resent.token, identity),
      ).resolves.toEqual({ kind: 'already-accepted' });
      await expect(directory.resendInvitation(first.invitation.id)).resolves.toMatchObject({
        kind: 'already-accepted',
      });
      await expect(directory.revokeInvitation(first.invitation.id)).resolves.toMatchObject({
        kind: 'already-accepted',
      });
    });

    it('revokes once, and a revoked invitation can be neither resent nor accepted', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const email = fixture.email('revoked');
      const { invitation, token } = created(
        await directory.createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
      );
      const revoked = await directory.revokeInvitation(invitation.id);
      if (revoked.kind !== 'revoked') throw new Error(revoked.kind);
      expect(revoked.invitation.revokedAt).not.toBeNull();
      await expect(directory.revokeInvitation(invitation.id)).resolves.toEqual({
        kind: 'already-revoked',
        invitation: revoked.invitation,
      });
      await expect(directory.resendInvitation(invitation.id)).resolves.toEqual({
        kind: 'revoked',
        invitation: revoked.invitation,
      });
      await expect(
        fixture.root.acceptInvitation(invitation.id, token, {
          email,
          issuer: 'https://idp.example',
          subject: fixture.email('sub'),
        }),
      ).resolves.toEqual({ kind: 'revoked' });
      // A revoked invitation no longer blocks a fresh one to the same address.
      created(
        await directory.createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
      );
    });

    it('answers invalid for a wrong id, token or email alike', async () => {
      const fixture = await makeFixture();
      const email = fixture.email('target');
      const { invitation, token } = created(
        await fixture.root
          .forWorkspace(fixture.a.id)
          .createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
      );
      const identity = { email, issuer: 'https://idp.example', subject: fixture.email('sub') };
      await expect(fixture.root.acceptInvitation(ABSENT, token, identity)).resolves.toEqual({
        kind: 'invalid',
      });
      await expect(
        fixture.root.acceptInvitation(invitation.id, `${token}x`, identity),
      ).resolves.toEqual({ kind: 'invalid' });
      await expect(
        fixture.root.acceptInvitation(invitation.id, token, {
          ...identity,
          email: fixture.email('someone-else'),
        }),
      ).resolves.toEqual({ kind: 'invalid' });
      expect(
        (await fixture.root.forWorkspace(fixture.a.id).listInvitations())[0]?.acceptedAt,
      ).toBeNull();
    });

    it('answers already-member when the invitee already belongs to the workspace', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      const owner = await ownerMembership(directory, fixture.a.owner.email);
      const { invitation, token } = created(
        await directory.createInvitation({
          email: fixture.a.owner.email,
          role: asOwner('viewer'),
          invitedBy: null,
        }),
      );
      await expect(
        fixture.root.acceptInvitation(invitation.id, token, {
          email: fixture.a.owner.email,
          issuer: 'https://idp.example',
          subject: fixture.email('sub'),
        }),
      ).resolves.toEqual({
        kind: 'already-member',
        workspaceId: fixture.a.id,
        userId: fixture.a.owner.userId,
        principalId: owner.principalId,
      });
      expect(await directory.listMemberships()).toEqual([owner]);
    });

    it('answers no-such-invitation for an id nobody has', async () => {
      const fixture = await makeFixture();
      const directory = fixture.root.forWorkspace(fixture.a.id);
      await expect(directory.resendInvitation(ABSENT)).resolves.toEqual({
        kind: 'no-such-invitation',
        id: ABSENT,
      });
      await expect(directory.revokeInvitation(ABSENT)).resolves.toEqual({
        kind: 'no-such-invitation',
        id: ABSENT,
      });
    });
  });
}

/** OIDC identities, users by email, and a user’s memberships across workspaces. */
function identities(makeFixture: MakeDirectoryFixture): void {
  describe('identities and cross-workspace memberships', () => {
    it('finds a user by email case-insensitively, and null for nobody', async () => {
      const fixture = await makeFixture();
      await expect(
        fixture.root.findUserByEmail(fixture.a.owner.email.toUpperCase()),
      ).resolves.toMatchObject({
        id: fixture.a.owner.userId,
        email: fixture.a.owner.email,
        name: fixture.a.owner.name,
      });
      await expect(fixture.root.findUserByEmail(fixture.email('nobody'))).resolves.toBeNull();
    });

    it('binds an identity idempotently and refuses to rebind it to another user', async () => {
      const fixture = await makeFixture();
      const subject = fixture.email('subject');
      await expect(fixture.root.findIdentity('https://idp.example', subject)).resolves.toBeNull();
      await fixture.root.linkIdentity('https://idp.example', subject, fixture.a.owner.userId);
      await fixture.root.linkIdentity('https://idp.example', subject, fixture.a.owner.userId);
      await expect(
        fixture.root.linkIdentity('https://idp.example', subject, fixture.b.owner.userId),
      ).rejects.toThrow('OIDC identity is already bound to a different user');
      await expect(fixture.root.findIdentity('https://idp.example', subject)).resolves.toEqual({
        userId: fixture.a.owner.userId,
        email: fixture.a.owner.email,
      });
      await expect(fixture.root.findIdentity('https://other.example', subject)).resolves.toBeNull();
    });

    it('lists a user’s current memberships by workspace name, and none for nobody', async () => {
      const fixture = await makeFixture();
      const joined = await fixture.root
        .forWorkspace(fixture.a.id)
        .createMembership({ email: fixture.b.owner.email, role: asOwner('viewer') });
      if (joined.kind !== 'created') throw new Error(joined.kind);
      const ownerB = await ownerMembership(
        fixture.root.forWorkspace(fixture.b.id),
        fixture.b.owner.email,
      );
      await expect(fixture.root.membershipsForUser(fixture.b.owner.userId)).resolves.toEqual([
        {
          principalId: joined.membership.principalId,
          workspaceId: fixture.a.id,
          workspaceSlug: fixture.a.slug,
          workspaceName: fixture.a.name,
          role: 'viewer',
        },
        {
          principalId: ownerB.principalId,
          workspaceId: fixture.b.id,
          workspaceSlug: fixture.b.slug,
          workspaceName: fixture.b.name,
          role: 'owner',
        },
      ]);
      await fixture.root.forWorkspace(fixture.a.id).deleteMembership(joined.membership.id);
      expect(
        (await fixture.root.membershipsForUser(fixture.b.owner.userId)).map(
          (row) => row.workspaceId,
        ),
      ).toEqual([fixture.b.id]);
      await expect(fixture.root.membershipsForUser(ABSENT)).resolves.toEqual([]);
    });
  });
}

/** Spec §25: one workspace’s rows are invisible from another’s. */
function isolation(makeFixture: MakeDirectoryFixture): void {
  describe('workspace isolation (spec §25)', () => {
    it('another workspace cannot list, change or delete a membership', async () => {
      const fixture = await makeFixture();
      const a = fixture.root.forWorkspace(fixture.a.id);
      const b = fixture.root.forWorkspace(fixture.b.id);
      const target = created(
        await a.createUser({ email: fixture.email('target'), name: 'T', role: asOwner('admin') }),
      ).membership;
      expect((await b.listUsers()).map((user) => user.email)).toEqual([fixture.b.owner.email]);
      expect((await b.listMemberships()).map((row) => row.email)).toEqual([fixture.b.owner.email]);
      await expect(b.changeMembershipRole(target.id, asOwner('owner'))).resolves.toEqual({
        kind: 'no-such-membership',
        id: target.id,
      });
      await expect(b.deleteMembership(target.id)).resolves.toEqual({
        kind: 'no-such-membership',
        id: target.id,
      });
      expect(await a.listMemberships()).toContainEqual(target);
    });

    it('another workspace cannot list, read or revoke a key', async () => {
      const fixture = await makeFixture();
      const a = fixture.root.forWorkspace(fixture.a.id);
      const b = fixture.root.forWorkspace(fixture.b.id);
      const { key, presented } = created(
        await a.createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null }),
      );
      await expect(b.listApiKeys()).resolves.toEqual([]);
      await expect(b.readStoredApiKey(key.id)).resolves.toBeNull();
      await expect(b.revokeApiKey(key.id)).resolves.toEqual({ kind: 'no-such-key', id: key.id });
      await expect(fixture.root.authenticateApiKey(presented, new Date())).resolves.toMatchObject({
        workspaceId: fixture.a.id,
      });
    });

    it('another workspace cannot list, resend or revoke an invitation', async () => {
      const fixture = await makeFixture();
      const a = fixture.root.forWorkspace(fixture.a.id);
      const b = fixture.root.forWorkspace(fixture.b.id);
      const { invitation } = created(
        await a.createInvitation({
          email: fixture.email('invitee'),
          role: asOwner('viewer'),
          invitedBy: null,
        }),
      );
      await expect(b.listInvitations()).resolves.toEqual([]);
      await expect(b.resendInvitation(invitation.id)).resolves.toEqual({
        kind: 'no-such-invitation',
        id: invitation.id,
      });
      await expect(b.revokeInvitation(invitation.id)).resolves.toEqual({
        kind: 'no-such-invitation',
        id: invitation.id,
      });
      expect(await a.listInvitations()).toEqual([invitation]);
    });
  });
}
