import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { describe, expect, it } from 'vitest';

import { createAgentRunResourceLoader } from '../compose/resource-loader';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createConnector, updateConnector } from './handlers';
import { createInMemoryConnectorsStoreProvider } from './memory-store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OWNER = { principalId: 'p1', userId: 'u1' };
const IDENTITY = { secret: 'SIGNING_KEY' };
const HTTP = { name: 'crm', transport: 'http', url: 'https://mcp.example.test' };
const OPENAPI = {
  kind: 'openapi',
  name: 'pets',
  document: JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1' },
    servers: [{ url: 'https://93.184.216.34/v1' }],
    paths: { '/pets': { get: { operationId: 'listPets', responses: {} } } },
  }),
  allow: ['GET /pets'],
  auth: 'none',
};

function loaderFor(provider: ReturnType<typeof createInMemoryConnectorsStoreProvider>) {
  return createAgentRunResourceLoader({
    catalog: createInMemoryCatalogStore(),
    skills: createInMemoryObjectStoreProvider(),
    connectors: provider,
  });
}

const idOf = (result: { body: unknown }): string => (result.body as { id: string }).id;

describe('connector identity opt-in (ADR-0142 D1)', () => {
  it('stores the secret name on http and openapi connectors and returns only the reference', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    for (const body of [
      { ...HTTP, identity: IDENTITY },
      { ...OPENAPI, identity: IDENTITY },
    ]) {
      const created = await createConnector(store, body, OWNER);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ identity: IDENTITY });
      expect(await store.get(idOf(created))).toMatchObject({ identity: IDENTITY });
    }
  });

  it('refuses a stdio connector that opts in, and stores nothing', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    const result = await createConnector(
      store,
      { name: 'local', transport: 'stdio', command: 'node', identity: IDENTITY },
      OWNER,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: 'connector_identity_unsupported' } });
    expect(await store.list()).toEqual([]);
  });

  it('refuses a postgres connector that opts in (the strict body rejects the key)', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    const result = await createConnector(
      store,
      {
        kind: 'postgres',
        name: 'shop',
        credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
        tables: ['public.orders'],
        readOnly: true,
        identity: IDENTITY,
      },
      OWNER,
    );
    expect(result.status).toBe(400);
    expect(await store.list()).toEqual([]);
  });

  it('opts an http connector in and out by update, refusing stdio', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    const id = idOf(await createConnector(store, HTTP, OWNER));
    const optedIn = await updateConnector(store, id, { identity: IDENTITY });
    expect(optedIn.status).toBe(200);
    expect(optedIn.body).toMatchObject({ identity: IDENTITY });
    const optedOut = await updateConnector(store, id, { identity: null });
    expect(optedOut.status).toBe(200);
    expect(optedOut.body).not.toHaveProperty('identity');

    const stdio = idOf(
      await createConnector(store, { name: 'local', transport: 'stdio', command: 'node' }, OWNER),
    );
    const refused = await updateConnector(store, stdio, { identity: IDENTITY });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: { code: 'connector_identity_unsupported' } });
  });

  // @story US-STO-12
  it('[US-STO-12][api][run] refuses a storage connection credential as the identity secret on create and update, and saves nothing', async () => {
    const reserved = { secret: 'STORAGE_CONNECTION_77777777777747778777777777777777' };
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    for (const body of [
      { ...HTTP, identity: reserved },
      { ...OPENAPI, identity: reserved },
    ]) {
      const refused = await createConnector(store, body, OWNER);
      expect(refused.status, body.name).toBe(400);
      expect(refused.body, body.name).toMatchObject({ error: { code: 'invalid_body' } });
    }
    expect(await store.list()).toEqual([]);

    const http = idOf(await createConnector(store, HTTP, OWNER));
    const patched = await updateConnector(store, http, { identity: reserved });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: { code: 'invalid_body' } });
    expect(await store.get(http)).not.toHaveProperty('identity');

    const openapi = idOf(await createConnector(store, { ...OPENAPI, identity: IDENTITY }, OWNER));
    const replaced = await updateConnector(store, openapi, { ...OPENAPI, identity: reserved });
    expect(replaced.status).toBe(400);
    expect(replaced.body).toMatchObject({ error: { code: 'invalid_body' } });
    expect(await store.get(openapi)).toMatchObject({ identity: IDENTITY });
  });

  it('clears the opt-in when an openapi connector is replaced without it', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
    const id = idOf(await createConnector(store, { ...OPENAPI, identity: IDENTITY }, OWNER));
    const replaced = await updateConnector(store, id, OPENAPI);
    expect(replaced.status).toBe(200);
    expect(replaced.body).not.toHaveProperty('identity');
  });
});

describe('run compose resolves the identity key (ADR-0142 D1)', () => {
  const selection = { files: [], skillIds: [] };

  it('hands over the key of an opted-in MCP connector and flags an opted-in tool connector', async () => {
    const provider = createInMemoryConnectorsStoreProvider({
      identityKeys: { SIGNING_KEY: 'k'.repeat(32) },
    });
    const store = provider.forWorkspace(WORKSPACE);
    const mcp = idOf(await createConnector(store, { ...HTTP, identity: IDENTITY }, OWNER));
    const plain = idOf(await createConnector(store, { ...HTTP, name: 'plain' }, OWNER));
    const tool = idOf(await createConnector(store, { ...OPENAPI, identity: IDENTITY }, OWNER));
    const loaded = await loaderFor(provider).load(WORKSPACE, {
      ...selection,
      connectorIds: [mcp, plain, tool],
    });
    expect(Object.values(loaded.connectorIdentities ?? {})).toEqual([
      { connectorId: mcp, key: 'k'.repeat(32) },
    ]);
    expect(loaded.toolConnectors?.map((entry) => entry.identity)).toEqual([true]);
  });

  it('refuses the run when the identity secret cannot be resolved', async () => {
    const provider = createInMemoryConnectorsStoreProvider();
    const id = idOf(
      await createConnector(
        provider.forWorkspace(WORKSPACE),
        { ...HTTP, identity: IDENTITY },
        OWNER,
      ),
    );
    await expect(
      loaderFor(provider).load(WORKSPACE, { ...selection, connectorIds: [id] }),
    ).rejects.toMatchObject({
      code: 'connector_identity_unsupported',
      publicMessage: expect.stringMatching(/^connector_identity_unsupported: /u) as unknown,
    });
  });
});
