/**
 * Pipeline step 4a over the PostgreSQL connection repository: the same refusals as
 * `pipeline.storage.test.ts`, with tenancy decided by the real `workspace_id` filter. A missing
 * `TEST_DATABASE_URL` makes `beforeAll` throw, so this suite fails instead of skipping.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import {
  resolveStorageGrants,
  storageConnectionLookup,
  type StorageConnectionLookup,
} from './storage-grants';

type Files = Parameters<typeof resolveStorageGrants>[0];

/** The refusal step 4a answers for `files`, or `null` when every grant is accepted. */
async function storageGrantRefusal(files: Files, lookup: StorageConnectionLookup) {
  const resolved = await resolveStorageGrants(files, lookup);
  return 'refusal' in resolved ? resolved.refusal : null;
}

describe('pipeline step 4a on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();

  const lookupOf = async (workspaceId: string) => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    return storageConnectionLookup(
      createDatabaseStorageConnectionRepositoryProvider(isolated.db).forScope(scope),
    );
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_sto_506_grants');
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: 'sto-a', name: 'A' },
      { id: workspaceB, slug: 'sto-b', name: 'B' },
    ]);
    const provider = createDatabaseStorageConnectionRepositoryProvider(isolated.db);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scopeA = await resolver.forWorkspaceId(workspaceA);
    const scopeB = await resolver.forWorkspaceId(workspaceB);
    if (scopeA === null || scopeB === null) throw new Error('fixture workspaces did not resolve');
    const connection = (name: string, writeAllowed: boolean) => ({
      id: crypto.randomUUID(),
      name,
      provider: 's3' as const,
      url: 's3://acme-bucket',
      allowedPrefixes: ['reports'],
      writeAllowed,
    });
    await provider.forScope(scopeA).create(connection('acme-data', false));
    await provider.forScope(scopeB).create(connection('b-only', true));
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a folder outside the allowed list is refused', async () => {
    const refusal = await storageGrantRefusal(
      [{ path: 'storage://acme-data/reports-old/x', access: 'read' }],
      await lookupOf(workspaceA),
    );
    expect(refusal).toMatchObject({
      status: 403,
      body: { error: { code: 'storage_connection_prefix_not_allowed' } },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] an agent is granted one folder, and writing needs an explicit grant', async () => {
    const lookup = await lookupOf(workspaceA);
    expect(
      await storageGrantRefusal(
        [{ path: 'storage://acme-data/reports/2026', access: 'read' }],
        lookup,
      ),
    ).toBeNull();
    expect(
      await storageGrantRefusal(
        [{ path: 'storage://acme-data/reports/2026', access: 'read-write' }],
        lookup,
      ),
    ).toMatchObject({
      status: 403,
      body: { error: { code: 'storage_connection_write_not_allowed' } },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a connection of another workspace is missing, not a grant', async () => {
    expect(
      await storageGrantRefusal(
        [{ path: 'storage://b-only/reports', access: 'read' }],
        await lookupOf(workspaceA),
      ),
    ).toMatchObject({
      status: 422,
      body: {
        error: {
          code: 'agent_definition_references_missing',
          details: ['file:storage://b-only/reports'],
        },
      },
    });
    expect(
      await storageGrantRefusal(
        [{ path: 'storage://b-only/reports', access: 'read-write' }],
        await lookupOf(workspaceB),
      ),
    ).toBeNull();
  });
});
