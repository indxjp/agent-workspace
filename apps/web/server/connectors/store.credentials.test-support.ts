import { expect, it } from 'vitest';
import { createDatabaseWorkspaceScopeResolver } from '@agent-workspace/core/db/unscoped';
import type { ConnectorStoreFixture } from './store.fixture.test-support';
export function registerConnectorCredentialsTests(
  getFixture: () => Pick<
    ConnectorStoreFixture,
    | 'store'
    | 'PLAINTEXT_MARKER'
    | 'PRINCIPAL_ID'
    | 'OWNER_ID'
    | 'isolated'
    | 'env'
    | 'workspace'
    | 'secretsService'
  >,
) {
  it('THE ACCEPTANCE CRITERION: the raw credential is never held on the connector row', async () => {
    const testContext = getFixture();

    const outcome = await testContext.store.create(
      {
        name: 'GitHub',
        transport: 'http',
        command: null,
        args: null,
        url: 'https://api.example.test/mcp',
        authType: 'bearer',
        credential: testContext.PLAINTEXT_MARKER,
      },
      { principalId: testContext.PRINCIPAL_ID, userId: testContext.OWNER_ID },
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe('created');
    if (outcome.kind !== 'created') return;

    const connectorRow = await testContext.isolated.db.query.mcpServers.findFirst({
      where: (row, { eq }) => eq(row.id, outcome.server.id),
    });
    expect(connectorRow).toBeDefined();

    const secretRow = await testContext.isolated.db.query.secrets.findFirst({
      where: (row, { eq }) => eq(row.id, outcome.server.credentialSecretId ?? ''),
    });
    expect(secretRow).toBeDefined();

    expect(JSON.stringify(connectorRow)).not.toContain(testContext.PLAINTEXT_MARKER);
    expect(connectorRow).toMatchObject({
      kind: 'mcp',
      toolConfig: null,
      openapiDocument: null,
      command: null,
      url: 'https://api.example.test/mcp',
      authType: 'bearer',
      credentialSecretId: outcome.server.credentialSecretId,
    });
    expect(Object.keys(connectorRow as object).sort()).toEqual(
      [
        'id',
        'workspaceId',
        'name',
        'kind',
        'transport',
        'command',
        'args',
        'url',
        'toolConfig',
        'openapiDocument',
        'authType',
        'credentialSecretId',
        'identitySecretName',
        'enabled',
        'createdBy',
        'ownerPrincipalId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    expect(secretRow?.ciphertext.toString('utf8')).not.toContain(testContext.PLAINTEXT_MARKER);
    expect(secretRow?.ciphertext.includes(Buffer.from(testContext.PLAINTEXT_MARKER, 'utf8'))).toBe(
      false,
    );
  });

  it('resolveForProbe decrypts the real secret and the probe uses it correctly', async () => {
    const testContext1 = getFixture();

    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

    const child = spawn(process.execPath, [path.join(fixturesDir, 'http-server.mjs')], {
      env: { ...getFixture().env, REQUIRE_TOKEN: testContext1.PLAINTEXT_MARKER, PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const match = /PORT=(\d+)/.exec(buffer);
          if (match?.[1] !== undefined) resolve(Number(match[1]));
        });
        child.once('error', reject);
      });

      const outcome = await testContext1.store.create(
        {
          name: 'RealProbeTarget',
          transport: 'http',
          command: null,
          args: null,
          url: `http://127.0.0.1:${String(port)}/mcp`,
          authType: 'bearer',
          credential: testContext1.PLAINTEXT_MARKER,
        },
        { principalId: testContext1.PRINCIPAL_ID, userId: testContext1.OWNER_ID },
      );
      if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);

      const config = await testContext1.store.resolveForProbe(outcome.server.id);
      expect(config).not.toBeNull();
      if (config === null) throw new Error('the connector probe did not resolve');
      const { testConnection } = await import('./test-connection.js');
      const { restrictedBaseEnv } = await import('./base-env.js');
      const result = await testConnection(config, { baseEnv: restrictedBaseEnv() });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('compensates a failed connector insert and deletes credentials with the connector', async () => {
    const testContext2 = getFixture();

    const input = {
      name: 'Compensated Connector',
      transport: 'http' as const,
      command: null,
      args: null,
      url: 'https://api.example.test/mcp',
      authType: 'bearer' as const,
      credential: 'temporary-credential-marker',
    };
    const first = await testContext2.store.create(input, {
      principalId: testContext2.PRINCIPAL_ID,
      userId: testContext2.OWNER_ID,
    });
    if (first.kind !== 'created') throw new Error(`fixture setup failed: ${first.kind}`);
    const scope = await createDatabaseWorkspaceScopeResolver(
      testContext2.isolated.db,
    ).forWorkspaceId(testContext2.workspace.id);
    if (scope === null) throw new Error('fixture workspace does not resolve');
    const beforeConflict = await testContext2.secretsService.list(scope);
    await expect(
      testContext2.store.create(input, {
        principalId: testContext2.PRINCIPAL_ID,
        userId: testContext2.OWNER_ID,
      }),
    ).resolves.toMatchObject({ kind: 'name-conflict' });
    expect(await testContext2.secretsService.list(scope)).toHaveLength(beforeConflict.length);

    await expect(
      testContext2.store.rotateCredential(first.server.id, 'rotated-credential-marker'),
    ).resolves.toMatchObject({ kind: 'rotated', connector: { id: first.server.id } });
    await expect(testContext2.store.delete(first.server.id)).resolves.toEqual({ kind: 'deleted' });
    expect(
      (await testContext2.secretsService.list(scope)).some(
        (row) => row.id === first.server.credentialSecretId,
      ),
    ).toBe(false);
  });
}
