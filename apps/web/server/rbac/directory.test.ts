/**
 * The RBAC directory conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link DirectoryRoot} (the port the RBAC and invitation routes hold), not against
 * an implementation, and exported as {@link describeDirectoryConformance}. It runs against:
 *
 *   1. `createMemoryDirectory()` — no database, always;
 *   2. `createPostgresDirectory()` over the durable repository and a **real PostgreSQL**, whenever
 *      `TEST_DATABASE_URL` names one.
 *
 * It holds the storage contract only — what each method stores, refuses, returns and in what
 * order, and §25's rule that one workspace's rows are invisible from another's. Who may call which
 * method is policy (`decide.ts`, `conferral.ts`) and is not tested here.
 *
 * The cases further down this file are the older in-memory-only checks; they stay because some of
 * them pin fixture behaviour (seeding, display names) the port does not describe.
 *
 * Presented keys and invitation tokens never reach test output: every "the secret is not in this"
 * check compares a boolean.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships as membershipsTable,
  users as usersTable,
  workspacePrincipals,
  workspaces as workspacesTable,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conferredBy, type ConferredRole } from './conferral';
import type {
  CreateApiKeyOutcome,
  CreateInvitationOutcome,
  CreateUserOutcome,
  DirectoryRoot,
  MembershipSummary,
  WorkspaceDirectory,
} from './directory';
import { listMemberships } from './handlers';
import { createMemoryDirectory } from './memory-directory';
import { createPostgresDirectory } from './postgres-directory';
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

const ABSENT = '55555555-5555-4555-8555-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HOUR = 60 * 60 * 1000;

/** One workspace that really exists in the implementation, with its only member, an Owner. */
export interface SeededWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly owner: { readonly userId: string; readonly email: string; readonly name: string };
}

/** One set-up for one test. `a` sorts before `b` by name. */
export interface DirectoryFixture {
  readonly root: DirectoryRoot;
  readonly a: SeededWorkspace;
  readonly b: SeededWorkspace;
  /** An email no other test uses: `users.email` is global, and the database outlives one test. */
  email(local: string): string;
}

export type MakeDirectoryFixture = () => Promise<DirectoryFixture>;

function createdUser(outcome: CreateUserOutcome) {
  if (outcome.kind !== 'created') throw new Error(`expected created, got "${outcome.kind}"`);
  return outcome;
}

function createdKey(outcome: CreateApiKeyOutcome) {
  if (outcome.kind !== 'created') throw new Error(`expected created, got "${outcome.kind}"`);
  return outcome;
}

function createdInvitation(outcome: CreateInvitationOutcome) {
  if (outcome.kind !== 'created') throw new Error(`expected created, got "${outcome.kind}"`);
  return outcome;
}

async function ownerMembership(
  directory: WorkspaceDirectory,
  email: string,
): Promise<MembershipSummary> {
  const found = (await directory.listMemberships()).find((row) => row.email === email);
  if (found === undefined) throw new Error('the fixture owner has no membership');
  return found;
}

/** The same key with one character of its secret changed. */
function tampered(presented: string): string {
  const last = presented.at(-1);
  return presented.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** Run the conformance suite against a fixture factory, called once per test. */
export function describeDirectoryConformance(
  label: string,
  makeFixture: MakeDirectoryFixture,
): void {
  describe(label, () => {
    describe('users and memberships', () => {
      it('creates a user and a membership, normalised, and lists both', async () => {
        const fixture = await makeFixture();
        const directory = fixture.root.forWorkspace(fixture.a.id);
        const email = fixture.email('builder');
        const outcome = createdUser(
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
        const outcome = createdUser(
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
          createdUser(
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

        const second = createdUser(
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
        const leaver = createdUser(
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
        const member = createdUser(
          await directory.createUser({
            email: fixture.email('principal'),
            name: 'Principal',
            role: asOwner('builder'),
          }),
        ).membership;
        await expect(directory.findMembershipByPrincipal(member.principalId)).resolves.toEqual(
          member,
        );
        // The membership's own id is not its principal, and another workspace has no such principal.
        await expect(directory.findMembershipByPrincipal(member.id)).resolves.toBeNull();
        await expect(other.findMembershipByPrincipal(member.principalId)).resolves.toBeNull();
        await expect(directory.findMembershipByPrincipal(ABSENT)).resolves.toBeNull();
        await expect(directory.findMembershipByPrincipal('not-a-uuid')).resolves.toBeNull();
        // An API key's principal is a principal, but not a member.
        const { presented } = createdKey(
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
        await expect(
          fixture.root.resolveRole(fixture.a.owner.email, fixture.b.id),
        ).resolves.toBeNull();
        await expect(
          fixture.root.resolveRole(fixture.email('nobody'), fixture.a.id),
        ).resolves.toBeNull();
      });
    });

    describe('api keys', () => {
      it('stores only a hash, and authenticates the presented key to its workspace and role', async () => {
        const fixture = await makeFixture();
        const directory = fixture.root.forWorkspace(fixture.a.id);
        const outcome = createdKey(
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
        const { presented } = createdKey(
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
        createdKey(await fixture.root.forWorkspace(fixture.a.id).createApiKey(input));
        await expect(
          fixture.root.forWorkspace(fixture.a.id).createApiKey({ ...input, name: ' deploy ' }),
        ).resolves.toEqual({ kind: 'name-taken', name: 'deploy' });
        createdKey(await fixture.root.forWorkspace(fixture.b.id).createApiKey(input));
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
        const { key, presented } = createdKey(
          await directory.createApiKey({
            name: 'short',
            role: asOwner('viewer'),
            expiresAt: expiresAt.toISOString(),
          }),
        );
        expect(key.expiresAt).toBe(expiresAt.toISOString());
        await expect(
          fixture.root.authenticateApiKey(presented, new Date()),
        ).resolves.not.toBeNull();
        await expect(
          fixture.root.authenticateApiKey(presented, new Date(expiresAt.getTime() + 1)),
        ).resolves.toBeNull();
      });

      it('revokes by timestamp, once, and the key stops authenticating', async () => {
        const fixture = await makeFixture();
        const directory = fixture.root.forWorkspace(fixture.a.id);
        const { key, presented } = createdKey(
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
          createdKey(
            await directory.createApiKey({ name, role: asOwner('viewer'), expiresAt: null }),
          );
        }
        expect((await directory.listApiKeys()).map((key) => key.name)).toEqual([
          'alpha',
          'mike',
          'zulu',
        ]);
      });
    });

    describe('invitations', () => {
      it('creates a pending invitation without its token, once per pending address', async () => {
        const fixture = await makeFixture();
        const directory = fixture.root.forWorkspace(fixture.a.id);
        const email = fixture.email('invitee');
        const { invitation, token } = createdInvitation(
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
          createdInvitation(
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
        const first = createdInvitation(
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
        await expect(fixture.root.findIdentity(identity.issuer, identity.subject)).resolves.toEqual(
          { userId: accepted.user.id, email },
        );

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
        const { invitation, token } = createdInvitation(
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
        createdInvitation(
          await directory.createInvitation({ email, role: asOwner('viewer'), invitedBy: null }),
        );
      });

      it('answers invalid for a wrong id, token or email alike', async () => {
        const fixture = await makeFixture();
        const email = fixture.email('target');
        const { invitation, token } = createdInvitation(
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
        const { invitation, token } = createdInvitation(
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
        await expect(
          fixture.root.findIdentity('https://other.example', subject),
        ).resolves.toBeNull();
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

    describe('workspace isolation (spec §25)', () => {
      it('another workspace cannot list, change or delete a membership', async () => {
        const fixture = await makeFixture();
        const a = fixture.root.forWorkspace(fixture.a.id);
        const b = fixture.root.forWorkspace(fixture.b.id);
        const target = createdUser(
          await a.createUser({ email: fixture.email('target'), name: 'T', role: asOwner('admin') }),
        ).membership;
        expect((await b.listUsers()).map((user) => user.email)).toEqual([fixture.b.owner.email]);
        expect((await b.listMemberships()).map((row) => row.email)).toEqual([
          fixture.b.owner.email,
        ]);
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
        const { key, presented } = createdKey(
          await a.createApiKey({ name: 'CI', role: asOwner('viewer'), expiresAt: null }),
        );
        await expect(b.listApiKeys()).resolves.toEqual([]);
        await expect(b.readStoredApiKey(key.id)).resolves.toBeNull();
        await expect(b.revokeApiKey(key.id)).resolves.toEqual({ kind: 'no-such-key', id: key.id });
        await expect(fixture.root.authenticateApiKey(presented, new Date())).resolves.toMatchObject(
          { workspaceId: fixture.a.id },
        );
      });

      it('another workspace cannot list, resend or revoke an invitation', async () => {
        const fixture = await makeFixture();
        const a = fixture.root.forWorkspace(fixture.a.id);
        const b = fixture.root.forWorkspace(fixture.b.id);
        const { invitation } = createdInvitation(
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
  });
}

// ── Implementation 1: memory ────────────────────────────────────────────────────────────────

describeDirectoryConformance('createMemoryDirectory — the DirectoryRoot contract', () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const workspace = (prefix: string): SeededWorkspace => ({
    id: crypto.randomUUID(),
    slug: `${prefix}-${tag}`,
    name: `${prefix} ${tag}`,
    owner: {
      userId: crypto.randomUUID(),
      email: `${prefix}-owner-${tag}@example.test`,
      name: `${prefix} Owner`,
    },
  });
  const a = workspace('alpha');
  const b = workspace('bravo');
  // A strictly increasing clock, so "newest first" is decided by write order and not by two writes
  // landing in the same millisecond; anchored at the real time so expiry checks stay meaningful.
  let now = Date.now();
  const root = createMemoryDirectory({
    users: [a, b].map((ws) => ({
      ...ws.owner,
      id: ws.owner.userId,
      workspaceId: ws.id,
      role: 'owner' as const,
    })),
    workspaces: [a, b].map(({ id, slug, name }) => ({ id, slug, name })),
    now: () => new Date((now += 1)),
    newId: () => crypto.randomUUID(),
  });
  return Promise.resolve({ root, a, b, email: (local) => `${local}-${tag}@example.test` });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[rbac/directory.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed directory satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL RBAC directory', () => {
  let isolated: IsolatedTestDatabase;
  let database: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_rbac_directory');
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await isolated.close();
  });

  async function workspace(prefix: string, tag: string): Promise<SeededWorkspace> {
    const seeded: SeededWorkspace = {
      id: crypto.randomUUID(),
      slug: `${prefix}-${tag}`,
      name: `${prefix} ${tag}`,
      owner: {
        userId: crypto.randomUUID(),
        email: `${prefix}-owner-${tag}@example.test`,
        name: `${prefix} Owner`,
      },
    };
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspacesTable)
      .values({ id: seeded.id, slug: seeded.slug, name: seeded.name });
    await isolated.db
      .insert(usersTable)
      .values({ id: seeded.owner.userId, email: seeded.owner.email, name: seeded.owner.name });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(membershipsTable).values({
        id: membershipId,
        workspaceId: seeded.id,
        userId: seeded.owner.userId,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: crypto.randomUUID(),
        workspaceId: seeded.id,
        kind: 'membership',
        membershipId,
      });
    });
    return seeded;
  }

  describeDirectoryConformance('over a real PostgreSQL, against the same suite', async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    return {
      root: createPostgresDirectory(database.directory),
      a: await workspace('alpha', tag),
      b: await workspace('bravo', tag),
      email: (local) => `${local}-${tag}@example.test`,
    };
  });
});

// ── In-memory-only checks (fixture behaviour the port does not describe) ────────────────────

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
