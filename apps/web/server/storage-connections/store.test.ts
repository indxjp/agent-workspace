// @story US-STO-12
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { storageConnectionLookup } from '../agent-versions/storage-grants';
import {
  createRepositoryStorageConnectionsStoreProvider,
  ORPHAN_CONNECTION_SECRET_GRACE_MS,
  storageConnectionSecretName,
} from './store';

const WORKSPACE = crypto.randomUUID();

const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'w' }]);

async function scopeOf(workspaceId: string) {
  const scope = await scopes.forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('the fixture workspace does not resolve');
  return scope;
}

function world() {
  const secrets = createInMemorySecretsService();
  const provider = createRepositoryStorageConnectionsStoreProvider({
    repositories: createInMemoryStorageConnectionRepositoryProvider(),
    scopes,
    secrets,
  });
  return { secrets, store: provider.forWorkspace(WORKSPACE) };
}

/** Built at run time: a key-shaped literal would trip the secret scanner. */
const s3Credential = () => ({
  provider: 's3' as const,
  accessKeyId: ['AK', 'IA'].join('') + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  secretAccessKey: crypto.randomUUID() + crypto.randomUUID(),
});

function connection(name: string, withCredential = false) {
  return {
    name,
    url: `s3://${name}`,
    provider: 's3' as const,
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    credential: withCredential ? s3Credential() : undefined,
  };
}

describe('the deploy-time storage-grant lookup over the web store', () => {
  it('[US-STO-12][unit][sdk] resolves only the named connections and reads no secret', async () => {
    const { secrets, store } = world();
    const wanted = await store.create(connection('acme-data'));
    await store.create(connection('acme-other'));
    if (wanted.kind !== 'created') throw new Error('the fixture connection was refused');
    const list = vi.spyOn(secrets, 'list');
    const resolve = vi.spyOn(secrets, 'resolveByName');

    const found = await storageConnectionLookup(store)(['acme-data', 'missing']);

    expect(Object.fromEntries(found)).toEqual({
      'acme-data': {
        id: wanted.connection.id,
        allowedPrefixes: ['reports'],
        writeAllowed: false,
      },
    });
    expect(list).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the secret a failed delete left behind', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[US-STO-12][unit][sdk] keeps the grace period at ten minutes', () => {
    expect(ORPHAN_CONNECTION_SECRET_GRACE_MS).toBe(10 * 60 * 1000);
  });

  it('[US-STO-12][unit][sdk] is removed by a later connection delete once the grace period has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const { secrets, store } = world();
    const orphaned = await store.create(connection('acme-orphan', true));
    const later = await store.create(connection('acme-later', true));
    if (orphaned.kind !== 'created' || later.kind !== 'created') {
      throw new Error('a fixture connection was refused');
    }
    vi.spyOn(secrets, 'delete').mockRejectedValueOnce(new Error('the secret store is down'));
    expect((await store.remove(orphaned.connection.id)).kind).toBe('changed');
    const names = async () =>
      (await secrets.list(await scopeOf(WORKSPACE))).map((secret) => secret.name);
    expect(await names()).toContain(storageConnectionSecretName(orphaned.connection.id));

    vi.setSystemTime(new Date(Date.now() + ORPHAN_CONNECTION_SECRET_GRACE_MS + 1));
    // A connection being created writes its secret before its row: a fresh secret is left alone.
    const inFlight = storageConnectionSecretName(crypto.randomUUID());
    await secrets.create(await scopeOf(WORKSPACE), {
      name: inFlight,
      value: Buffer.from('{}', 'utf8'),
    });
    expect((await store.remove(later.connection.id)).kind).toBe('changed');

    expect(await names()).toEqual([inFlight]);
  });
});
