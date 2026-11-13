import { expect, it } from 'vitest';
import { createDatabaseWorkspaceScopeResolver } from '@agent-workspace/core/db/unscoped';
import { admitToolConnector } from './tools';
import type { ConnectorStoreFixture } from './store.fixture.test-support';
export function registerConnectorToolsTests(
  getFixture: () => Pick<
    ConnectorStoreFixture,
    | 'isolated'
    | 'workspace'
    | 'PRINCIPAL_ID'
    | 'OWNER_ID'
    | 'PLAINTEXT_MARKER'
    | 'store'
    | 'secretsService'
  >,
) {
  it('stores tool connectors beside MCP ones, seals and retires their credentials, and deletes them', async () => {
    const testContext = getFixture();

    const scope = await createDatabaseWorkspaceScopeResolver(
      testContext.isolated.db,
    ).forWorkspaceId(testContext.workspace.id);
    if (scope === null) throw new Error('fixture workspace does not resolve');
    const open = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });
    const document = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1' },
      servers: [{ url: 'https://93.184.216.34/v1' }],
      paths: {
        '/pets': { get: { operationId: 'listPets', responses: {} } },
        '/pets/{id}': { get: { operationId: 'showPet', responses: {} } },
      },
    });
    const admit = async (body: Record<string, unknown>) => {
      const admitted = await admitToolConnector(body, open);
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.result));
      return admitted.write;
    };
    const owner = { principalId: testContext.PRINCIPAL_ID, userId: testContext.OWNER_ID };
    const openapiBody = {
      kind: 'openapi',
      name: 'Pets tool',
      document,
      allow: ['GET /pets'],
      auth: 'bearer',
      credential: testContext.PLAINTEXT_MARKER,
    };

    const created = await testContext.store.createToolConnector(await admit(openapiBody), owner);
    if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
    expect(created.connector).toMatchObject({
      kind: 'openapi',
      transport: null,
      hasCredential: true,
    });
    expect(JSON.stringify(created.connector)).not.toContain(testContext.PLAINTEXT_MARKER);
    const postgres = await testContext.store.createToolConnector(
      await admit({
        kind: 'postgres',
        name: 'Shop tool',
        credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
        tables: ['public.orders'],
        readOnly: true,
      }),
      owner,
    );
    expect(postgres).toMatchObject({ kind: 'created', connector: { kind: 'postgres' } });
    await expect(
      testContext.store.createToolConnector(await admit({ ...openapiBody, name: 'GitHub' }), owner),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'GitHub' });

    const listed = await testContext.store.list();
    expect(listed.map((connector) => connector.name)).toEqual(
      expect.arrayContaining(['Pets tool', 'Shop tool']),
    );
    const firstSecrets = (await testContext.secretsService.list(scope)).map((row) => row.id);

    const replaced = await testContext.store.replaceToolConnector(
      created.connector.id,
      await admit({ ...openapiBody, allow: ['GET /pets', 'GET /pets/*'], credential: 'next' }),
    );
    expect(replaced).toMatchObject({ kind: 'updated' });
    if (replaced.kind === 'updated') expect(replaced.connector.openapi?.operations).toHaveLength(2);
    const afterReplace = (await testContext.secretsService.list(scope)).map((row) => row.id);
    expect(afterReplace).toHaveLength(firstSecrets.length);
    expect(afterReplace).not.toEqual(firstSecrets);

    const before = await testContext.secretsService.list(scope);
    await expect(testContext.store.delete(created.connector.id)).resolves.toEqual({
      kind: 'deleted',
    });
    expect(await testContext.secretsService.list(scope)).toHaveLength(before.length - 1);
    await expect(testContext.store.get(created.connector.id)).resolves.toBeNull();
  });
}
