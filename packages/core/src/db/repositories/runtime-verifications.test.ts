import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRuntimeVerificationRepositoryProvider } from './runtime-verifications.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const pass = (configurationKey: string, fingerprint: string) => ({
  configurationKey,
  fingerprint,
  verifiedAt: new Date('2026-10-10T12:00:00.000Z'),
  expiresAt: new Date('2026-10-10T13:00:00.000Z'),
});

describe.skipIf(!hasDatabase)('RuntimeVerificationRepository (issue #827)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_runtime_verifications');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Verified' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
  }, 180_000);

  afterAll(async () => isolated.close());

  async function repositoryFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('the test workspace is missing');
    // A new provider each call: a pass must be read back from the database, not from memory.
    return createDatabaseRuntimeVerificationRepositoryProvider(isolated.db).forScope(scope);
  }

  it('reads, through a new provider, a pass recorded through another', async () => {
    await (await repositoryFor(workspaceId)).record('external', pass('key-1', 'fp-1'));

    await expect((await repositoryFor(workspaceId)).get('external')).resolves.toEqual(
      pass('key-1', 'fp-1'),
    );
  });

  it('does not show one workspace the pass of another', async () => {
    await expect((await repositoryFor(otherWorkspaceId)).get('external')).resolves.toBeNull();
  });

  it('replaces the driver pass on a second record', async () => {
    const repository = await repositoryFor(workspaceId);
    await repository.record('external', pass('key-2', 'fp-2'));

    await expect(repository.get('external')).resolves.toEqual(pass('key-2', 'fp-2'));
  });
});
