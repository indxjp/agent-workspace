/**
 * A storage connection's credential is written only by `/api/storage-connections`, which binds it to
 * the connection's URL. The generic secrets routes refuse every `STORAGE_CONNECTION_` name on create
 * and replace, whether or not the connection exists, so no bare credential can be planted under a
 * connection's name or swapped in beside its bound one. Delete is refused while the connection
 * exists and allowed for an orphan, which sends no credential anywhere. A name whose suffix is no
 * connection id (`STORAGE_CONNECTION_ANYTHING`) can never belong to a connection: it is an orphan.
 *
 * The routes run over the real repository adapter (`./store`), so its connection lookup is what
 * refuses a live connection's credential; the in-memory secrets service checks no references.
 */
// @story US-STO-12
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { afterEach, describe, expect, it } from 'vitest';

import { POST as createRoute, GET as listRoute } from '../../app/api/secrets/route';
import { DELETE as deleteRoute, PUT as replaceRoute } from '../../app/api/secrets/[id]/route';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createRepositorySecretsStoreProvider } from './store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '77777777-7777-4777-8777-777777777777';
const RESERVED = `STORAGE_CONNECTION_${CONNECTION_ID.replaceAll('-', '').toUpperCase()}`;
const VALUE = JSON.stringify({ provider: 'file' });

afterEach(() => clearApplicationContext());

/** The real routes and adapter over in-memory services; returned to seed what the routes refuse. */
function useRuntime() {
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
  const storageConnections = createInMemoryStorageConnectionRepositoryProvider();
  const secrets = createRepositorySecretsStoreProvider({
    service: createInMemorySecretsService(),
    scopes,
    storageConnections,
  });
  installTestDomains({
    secrets: {
      kind: 'serving',
      runtime: {
        secrets,
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      },
    },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'Reserved secret names test',
          }),
        ),
    },
  });
  const store = secrets.forWorkspace(WORKSPACE);
  /** A storage connection with id `CONNECTION_ID`, so its credential is no orphan. */
  const connect = async () => {
    const scope = await scopes.forWorkspaceId(WORKSPACE);
    if (scope === null) throw new Error('the workspace resolves');
    await storageConnections.forScope(scope).create({
      id: CONNECTION_ID,
      name: 'acme-data',
      provider: 'file',
      url: 'file:///srv/data',
      allowedPrefixes: [],
      writeAllowed: false,
    });
  };
  return Object.assign(store, { connect });
}

function call(method: string, path: string, body?: unknown): Request {
  return new Request(`https://example.invalid${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seeded(store: ReturnType<typeof useRuntime>, name: string): Promise<string> {
  const outcome = await store.create({ name, value: Buffer.from(VALUE) });
  if (outcome.kind !== 'created') throw new Error('the secret is seeded');
  return outcome.secret.id;
}

describe('the generic secrets routes and storage-connection credential names', () => {
  it('[US-STO-12][api][sdk] refuses to create a secret under a storage connection name', async () => {
    useRuntime();
    for (const name of [RESERVED, 'STORAGE_CONNECTION_ANYTHING']) {
      const refused = await createRoute(call('POST', '/api/secrets', { name, value: VALUE }));
      expect(refused.status, name).toBe(409);
      expect(await refused.json(), name).toMatchObject({ error: { code: 'secret_name_conflict' } });
    }
    const listed = await listRoute(call('GET', '/api/secrets'));
    expect(await listed.json()).toEqual({ secrets: [] });
  });

  it('[US-STO-12][api][sdk] refuses to replace a storage connection credential, even an orphan one', async () => {
    const store = useRuntime();
    const id = await seeded(store, RESERVED);
    const refused = await replaceRoute(call('PUT', `/api/secrets/${id}`, { value: VALUE }), {
      params: Promise.resolve({ id }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'secret_in_use', details: [`storage-connection:${CONNECTION_ID}`] },
    });
  });

  it("[US-STO-12][api][sdk] refuses to delete a storage connection's credential while the connection exists", async () => {
    const store = useRuntime();
    await store.connect();
    const id = await seeded(store, RESERVED);
    const refused = await deleteRoute(call('DELETE', `/api/secrets/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'secret_in_use', details: [`storage-connection:${CONNECTION_ID}`] },
    });
    expect((await store.list()).map((secret) => secret.id)).toEqual([id]);
  });

  it('[US-STO-12][api][sdk] deletes an orphaned storage connection credential, and a name with no connection id', async () => {
    const store = useRuntime();
    for (const name of [RESERVED, 'STORAGE_CONNECTION_ANYTHING']) {
      const id = await seeded(store, name);
      const deleted = await deleteRoute(call('DELETE', `/api/secrets/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(deleted.status, name).toBe(204);
    }
    expect(await store.list()).toEqual([]);
  });

  it('[US-STO-12][api][sdk] refuses to replace a live connection credential too', async () => {
    const store = useRuntime();
    await store.connect();
    const id = await seeded(store, RESERVED);
    const refused = await replaceRoute(call('PUT', `/api/secrets/${id}`, { value: VALUE }), {
      params: Promise.resolve({ id }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'secret_in_use' } });
  });

  it('[US-STO-12][api][sdk] still creates, replaces and deletes an ordinary secret', async () => {
    useRuntime();
    const created = await createRoute(
      call('POST', '/api/secrets', { name: 'STORAGE_KEY', value: VALUE }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const replaced = await replaceRoute(call('PUT', `/api/secrets/${id}`, { value: VALUE }), {
      params: Promise.resolve({ id }),
    });
    expect(replaced.status).toBe(200);
    const deleted = await deleteRoute(call('DELETE', `/api/secrets/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(deleted.status).toBe(204);
  });
});

describe('the generic secrets routes and webhook signing secret names', () => {
  const SIGNING = 'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET';

  it('refuses to create a secret under a webhook signing secret name', async () => {
    useRuntime();
    const refused = await createRoute(
      call('POST', '/api/secrets', { name: SIGNING, value: 'whsec_' }),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'secret_name_conflict' } });
    expect(await (await listRoute(call('GET', '/api/secrets'))).json()).toEqual({ secrets: [] });
  });

  it('refuses to replace a webhook signing secret, and still deletes it', async () => {
    const store = useRuntime();
    const id = await seeded(store, SIGNING);
    const refused = await replaceRoute(call('PUT', `/api/secrets/${id}`, { value: 'whsec_' }), {
      params: Promise.resolve({ id }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'secret_in_use' } });
    const deleted = await deleteRoute(call('DELETE', `/api/secrets/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(deleted.status).toBe(204);
  });

  it('treats a name of another shape as an ordinary secret', async () => {
    useRuntime();
    const created = await createRoute(
      call('POST', '/api/secrets', { name: 'WEBHOOK_STRIPE_SIGNING_SECRET', value: VALUE }),
    );
    expect(created.status).toBe(201);
  });
});
