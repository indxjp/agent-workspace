/**
 * Issue #509 (S1-24): a local start reassigns what earlier local runtime keys own to the member
 * they act for, in one idempotent repair across the seven owner columns, leaving hosted keys,
 * members and actor attribution untouched. Against PostgreSQL.
 */
import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { apiKeys } from '../schema/api-keys.js';
import {
  LOCAL_PREFIX,
  OWNS_NOTHING,
  OWNS_ONE_OF_EACH,
  useOwnershipFixtures,
} from './local-runtime-ownership.test-support.js';

const hasDatabase = (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

describe.skipIf(!hasDatabase)('local runtime key ownership repair (issue #509, S1-24)', () => {
  const fixtures = useOwnershipFixtures('aw_s1_24_local_reassign');
  const { owned, actsForOf, key, ownEverything } = fixtures;

  it('moves every owner column from local keys (revoked and expired included) to the member, once', async () => {
    const { workspaceId, directory, admin, other } = await fixtures.workspace();
    const live = await key(directory, `${LOCAL_PREFIX}DDDDDDDD`);
    const revoked = await key(directory, `${LOCAL_PREFIX}EEEEEEEE`);
    const expired = await key(directory, `${LOCAL_PREFIX}FFFFFFFF`);
    const hosted = await key(directory, 'hosted key');
    const lookalike = await key(directory, 'aw dev local runtim_ lookalike');
    await directory.revokeApiKey(revoked.id, new Date());
    await fixtures.db
      .update(apiKeys)
      .set({
        createdAt: sql`now() - interval '2 days'`,
        expiresAt: sql`now() - interval '1 day'`,
      })
      .where(eq(apiKeys.id, expired.id));
    const localKeys = [live, revoked, expired];
    const keptKeys = [hosted, lookalike, other];
    for (const { principalId } of [...localKeys, ...keptKeys]) {
      await ownEverything(workspaceId, principalId);
    }
    const before = await fixtures.editedAt(workspaceId);

    const first = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(first.reassigned).toBe(localKeys.length * OWNS_ONE_OF_EACH.length);
    // A change of owner is not an edit: `updated_at` (what `aw push` compares) is untouched.
    expect(await fixtures.editedAt(workspaceId)).toEqual(before);
    await expect(owned(workspaceId, admin.principalId)).resolves.toEqual([3, 3, 3, 3, 3, 3, 3]);
    for (const { principalId } of localKeys) {
      await expect(owned(workspaceId, principalId)).resolves.toEqual(OWNS_NOTHING);
      await expect(actsForOf(principalId)).resolves.toBe(admin.principalId);
    }
    // Hosted keys, a name that only looks like the prefix, and members keep what they own.
    for (const { principalId } of keptKeys) {
      await expect(owned(workspaceId, principalId)).resolves.toEqual(OWNS_ONE_OF_EACH);
    }
    await expect(actsForOf(hosted.principalId)).resolves.toBeNull();

    // Actor attribution keeps the acting key.
    const actors = await fixtures.auditActors(workspaceId);
    expect(actors).toEqual(expect.arrayContaining([live.principalId, revoked.principalId]));
    expect(actors).not.toContain(admin.principalId);

    const second = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(second.reassigned).toBe(0);
  });

  it('moves a key that already records whom it acts for to that member, not the caller', async () => {
    const { workspaceId, directory, admin, other } = await fixtures.workspace();
    const actsForOther = await key(directory, `${LOCAL_PREFIX}GGGGGGGG`, other.principalId);
    await ownEverything(workspaceId, actsForOther.principalId);
    const outcome = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(outcome.reassigned).toBe(OWNS_ONE_OF_EACH.length);
    await expect(owned(workspaceId, other.principalId)).resolves.toEqual(OWNS_ONE_OF_EACH);
    await expect(owned(workspaceId, admin.principalId)).resolves.toEqual(OWNS_NOTHING);
    await expect(actsForOf(actsForOther.principalId)).resolves.toBe(other.principalId);
  });

  it('throws with nothing changed when the target is not an active member principal', async () => {
    const { workspaceId, directory, admin } = await fixtures.workspace();
    const local = await key(directory, `${LOCAL_PREFIX}HHHHHHHH`);
    const hosted = await key(directory, 'hosted target');
    await ownEverything(workspaceId, local.principalId);
    for (const target of [hosted.principalId, crypto.randomUUID()]) {
      await expect(
        directory.reassignLocalRuntimeKeyOwnership({
          toPrincipalId: target,
        }),
      ).rejects.toThrow(/active membership principal/u);
    }
    await expect(owned(workspaceId, local.principalId)).resolves.toEqual(OWNS_ONE_OF_EACH);
    await expect(actsForOf(local.principalId)).resolves.toBeNull();
    expect(admin.principalId).not.toBe(local.principalId);
  });
});
