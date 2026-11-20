/**
 * Issue #509 (S1-24): an API-key principal may act for a membership principal, and a local start
 * reassigns what earlier local runtime keys own to the member they act for.
 *
 * Against PostgreSQL, because the properties are the database's: the tenant-paired self FK and the
 * two CHECKs on `workspace_principals.acts_for_principal_id`, the acts-for conjunct in
 * `authenticateApiKeyHash` and `principalById`, and the one-transaction, idempotent repair across
 * the seven owner columns, which must leave hosted keys, members and actor attribution untouched.
 */
import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { workspacePrincipals } from '../schema/workspace-principals.js';
import {
  createDatabaseDirectoryRoot,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  type DatabaseWorkspaceDirectory,
} from './directory.js';
import {
  failure,
  keyHash,
  LOCAL_PREFIX,
  useOwnershipFixtures,
  violation,
} from './local-runtime-ownership.test-support.js';

describe('the local runtime key prefix the repair selects (issue #509, S1-24)', () => {
  it('is fixed by core and cannot be chosen by a caller', () => {
    expect(LOCAL_RUNTIME_API_KEY_NAME_PREFIX).toBe(LOCAL_PREFIX);
    // A caller-chosen prefix (an empty one matches every key, hosted ones included) would let the
    // repair backfill acts_for on hosted keys; the input names only the target member.
    expectTypeOf<
      Parameters<DatabaseWorkspaceDirectory['reassignLocalRuntimeKeyOwnership']>[0]
    >().toEqualTypeOf<{ readonly toPrincipalId: string }>();
  });
});

const hasDatabase = (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

describe.skipIf(!hasDatabase)('local runtime key ownership (issue #509, S1-24)', () => {
  const fixtures = useOwnershipFixtures('aw_s1_24_local_ownership');
  const { actsForOf, key } = fixtures;

  const revokeMember = (principalId: string) =>
    fixtures.db
      .update(workspacePrincipals)
      .set({ revokedAt: sql`now()` })
      .where(eq(workspacePrincipals.id, principalId));

  it('records acts_for on a new key and refuses a foreign, api-key or revoked target', async () => {
    const { workspaceId, directory, admin } = await fixtures.workspace();
    const local = await key(directory, `${LOCAL_PREFIX}AAAAAAAA`, admin.principalId);
    await expect(actsForOf(local.principalId)).resolves.toBe(admin.principalId);
    const listed = (await directory.listApiKeys()).find((row) => row.id === local.id);
    expect(listed?.actsForPrincipalId).toBe(admin.principalId);

    const hosted = await key(directory, 'ci key');
    await expect(actsForOf(hosted.principalId)).resolves.toBeNull();

    const foreign = await fixtures.workspace();
    for (const target of [foreign.admin.principalId, hosted.principalId, crypto.randomUUID()]) {
      await expect(
        directory.createApiKey({
          name: `${LOCAL_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
          role: 'admin',
          keyPrefix: `ak_live_${crypto.randomUUID().slice(0, 8)}`,
          keyHash: keyHash(),
          expiresAt: null,
          actsForPrincipalId: target,
        }),
      ).rejects.toThrow(/act only for an active membership principal/u);
    }

    // A revoked membership principal is no target either, and nothing was inserted for it.
    await revokeMember(admin.principalId);
    const before = (await directory.listApiKeys()).length;
    await expect(key(directory, `${LOCAL_PREFIX}BBBBBBBB`, admin.principalId)).rejects.toThrow(
      /act only for an active membership principal/u,
    );
    expect((await directory.listApiKeys()).length).toBe(before);
    expect(workspaceId).toBeTruthy();
  });

  it('authenticates and resolves a key with its acts-for principal, and stops once that member is gone', async () => {
    const { workspaceId, directory, admin } = await fixtures.workspace();
    const root = createDatabaseDirectoryRoot(fixtures.db);
    const local = await key(directory, `${LOCAL_PREFIX}CCCCCCCC`, admin.principalId);
    const hosted = await key(directory, 'hosted admin key');

    const authenticated = await root.authenticateApiKeyHash(local.hash, new Date());
    expect(authenticated?.actsForPrincipalId).toBe(admin.principalId);
    const hostedAuthenticated = await root.authenticateApiKeyHash(hosted.hash, new Date());
    expect(hostedAuthenticated?.actsForPrincipalId).toBeNull();
    await expect(root.principalById(workspaceId, local.principalId)).resolves.toMatchObject({
      kind: 'api_key',
      actsForPrincipalId: admin.principalId,
    });
    await expect(root.principalById(workspaceId, admin.principalId)).resolves.toMatchObject({
      kind: 'membership',
      actsForPrincipalId: null,
    });

    await revokeMember(admin.principalId);
    await expect(root.authenticateApiKeyHash(local.hash, new Date())).resolves.toBeNull();
    await expect(root.principalById(workspaceId, local.principalId)).resolves.toBeNull();
    // A hosted key never depended on that member.
    await expect(root.authenticateApiKeyHash(hosted.hash, new Date())).resolves.not.toBeNull();
  });

  it('refuses acts_for on a membership principal and acts_for pointing at itself', async () => {
    const { directory, admin, other } = await fixtures.workspace();
    const local = await key(directory, `${LOCAL_PREFIX}IIIIIIII`);
    const onMembership = await failure(
      fixtures.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: admin.principalId })
        .where(eq(workspacePrincipals.id, other.principalId)),
    );
    expect(violation(onMembership)).toEqual({
      code: '23514',
      constraint: 'workspace_principals_acts_for_api_key_only',
    });
    const onSelf = await failure(
      fixtures.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: local.principalId })
        .where(eq(workspacePrincipals.id, local.principalId)),
    );
    expect(violation(onSelf)).toEqual({
      code: '23514',
      constraint: 'workspace_principals_acts_for_not_self',
    });
    const foreign = await fixtures.workspace();
    const crossTenant = await failure(
      fixtures.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: foreign.admin.principalId })
        .where(eq(workspacePrincipals.id, local.principalId)),
    );
    expect(violation(crossTenant)).toEqual({
      code: '23503',
      constraint: 'workspace_principals_acts_for_workspace_fk',
    });
  });

  it('refuses, as a typed outcome, to delete a member a revoked local key acted for', async () => {
    const { directory, admin } = await fixtures.workspace();
    const second = await directory.createUser({
      email: `second-${crypto.randomUUID()}@example.test`,
      name: 'Second owner',
      role: 'owner',
    });
    if (second.kind !== 'created') throw new Error(second.kind);
    const local = await key(directory, `${LOCAL_PREFIX}JJJJJJJJ`, admin.principalId);
    expect((await directory.revokeApiKey(local.id, new Date())).kind).toBe('revoked');
    // A refusal, never the raw `workspace_principals_acts_for_workspace_fk` violation the route
    // would otherwise answer as an unhandled 500.
    await expect(directory.deleteMembership(admin.membershipId)).resolves.toEqual({
      kind: 'membership-in-use',
      id: admin.membershipId,
      dependency: 'local-runtime-keys',
    });
    const remaining = await directory.listMemberships();
    expect(remaining.map((membership) => membership.id)).toContain(admin.membershipId);
    // The baseline: a member no local key acted for is still deleted.
    expect(await directory.deleteMembership(second.membership.id)).toEqual({
      kind: 'deleted',
      id: second.membership.id,
    });
  });
});
