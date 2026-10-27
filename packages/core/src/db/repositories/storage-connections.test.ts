import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaces } from '../schema/workspaces.js';
import { createInMemoryStorageConnectionRepositoryProvider } from './memory-storage-connections.js';
import {
  createDatabaseWorkspaceScopeResolver,
  createInMemoryWorkspaceScopeResolver,
} from './scope.js';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  type StorageConnectionRepository,
} from './storage-connections.js';
import { describeStorageConnectionsConformance } from './storage-connections.contract.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

describeStorageConnectionsConformance('the in-memory repository', async () => {
  const ids = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: ids.a, slug: 'a' },
    { id: ids.b, slug: 'b' },
  ]);
  const provider = createInMemoryStorageConnectionRepositoryProvider();
  const scope = { a: await scopes.forWorkspaceId(ids.a), b: await scopes.forWorkspaceId(ids.b) };
  return {
    repository: (workspace) => {
      const resolved = scope[workspace];
      if (resolved === null) throw new Error('fixture workspace did not resolve');
      return provider.forScope(resolved);
    },
  };
});

describe('StorageConnectionRepository against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;

  // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_storage_connections');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  describeStorageConnectionsConformance('the PostgreSQL repository', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const rows = [`a-${suffix}`, `b-${suffix}`].map((slug) => ({
      id: crypto.randomUUID(),
      slug,
      name: slug,
    }));
    await isolated.db.insert(workspaces).values(rows);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const provider = createDatabaseStorageConnectionRepositoryProvider(isolated.db);
    const repositories: Record<'a' | 'b', StorageConnectionRepository> = {
      a: provider.forScope(await scopeOf(resolver, rows[0]?.id)),
      b: provider.forScope(await scopeOf(resolver, rows[1]?.id)),
    };
    return { repository: (workspace) => repositories[workspace] };
  });

  it('[US-STO-12][contract][sdk] the table has no column that could hold a credential', async () => {
    const result = await isolated.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'storage_connections'`,
    );
    const names = result.rows.map((row) => String(row['column_name']));
    expect(names.sort()).toEqual(
      [
        'allowed_prefixes',
        'created_at',
        'id',
        'name',
        'provider',
        'updated_at',
        'url',
        'workspace_id',
        'write_allowed',
      ].sort(),
    );
  });
});

async function scopeOf(
  resolver: ReturnType<typeof createDatabaseWorkspaceScopeResolver>,
  id: string | undefined,
) {
  const scope = id === undefined ? null : await resolver.forWorkspaceId(id);
  if (scope === null) throw new Error('fixture workspace did not resolve');
  return scope;
}
