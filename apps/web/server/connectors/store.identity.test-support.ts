import { expect, it } from 'vitest';
import { createDatabaseWorkspaceScopeResolver } from '@agent-workspace/core/db/unscoped';
import type { ConnectorStoreFixture } from './store.fixture.test-support';
export function registerConnectorIdentityTests(
  getFixture: () => Pick<
    ConnectorStoreFixture,
    'isolated' | 'workspace' | 'PRINCIPAL_ID' | 'OWNER_ID' | 'secretsService' | 'store'
  >,
) {
  it('resolves the identity signing key by secret name, and reports an unresolvable one as null', async () => {
    const testContext = getFixture();

    const scope = await createDatabaseWorkspaceScopeResolver(
      testContext.isolated.db,
    ).forWorkspaceId(testContext.workspace.id);
    if (scope === null) throw new Error('fixture workspace does not resolve');
    const owner = { principalId: testContext.PRINCIPAL_ID, userId: testContext.OWNER_ID };
    const sealed = await testContext.secretsService.create(scope, {
      name: 'IDENTITY_SIGNING_KEY',
      value: Buffer.from('identity-key-value', 'utf8'),
    });
    expect(sealed.kind).toBe('created');
    const input = {
      transport: 'http' as const,
      command: null,
      args: null,
      url: 'https://identity.example.test/mcp',
      authType: 'none' as const,
      credential: null,
    };
    const optedIn = await testContext.store.create(
      { ...input, name: 'identity-in', identity: { secret: 'IDENTITY_SIGNING_KEY' } },
      owner,
    );
    const dangling = await testContext.store.create(
      { ...input, name: 'identity-dangling', identity: { secret: 'NOT_A_SECRET' } },
      owner,
    );
    const plain = await testContext.store.create({ ...input, name: 'identity-plain' }, owner);
    if (optedIn.kind !== 'created' || dangling.kind !== 'created' || plain.kind !== 'created') {
      throw new Error('fixture connectors were not created');
    }
    await expect(testContext.store.resolveIdentityKey(optedIn.server.id)).resolves.toBe(
      'identity-key-value',
    );
    await expect(testContext.store.resolveIdentityKey(dangling.server.id)).resolves.toBeNull();
    await expect(testContext.store.resolveIdentityKey(plain.server.id)).resolves.toBeUndefined();

    // @story US-STO-12: a row stored before the contracts refused the name never reads it.
    const reserved = await testContext.secretsService.create(scope, {
      name: 'STORAGE_CONNECTION_77777777777747778777777777777777',
      value: Buffer.from('storage-credential-envelope', 'utf8'),
    });
    expect(reserved.kind).toBe('created');
    const storageNamed = await testContext.store.create(
      {
        ...input,
        name: 'identity-storage',
        identity: { secret: 'STORAGE_CONNECTION_77777777777747778777777777777777' },
      },
      owner,
    );
    if (storageNamed.kind !== 'created') throw new Error('fixture connector was not created');
    await expect(testContext.store.resolveIdentityKey(storageNamed.server.id)).resolves.toBeNull();

    // A webhook's signing secret is platform-owned too: a connector identity never reads it.
    const signing = await testContext.secretsService.create(scope, {
      name: 'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET',
      value: Buffer.from('whsec_c2lnbmluZw==', 'utf8'),
    });
    expect(signing.kind).toBe('created');
    const webhookNamed = await testContext.store.create(
      {
        ...input,
        name: 'identity-webhook',
        identity: { secret: 'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET' },
      },
      owner,
    );
    if (webhookNamed.kind !== 'created') throw new Error('fixture connector was not created');
    await expect(testContext.store.resolveIdentityKey(webhookNamed.server.id)).resolves.toBeNull();
    await expect(testContext.store.get(optedIn.server.id)).resolves.toMatchObject({
      identity: { secret: 'IDENTITY_SIGNING_KEY' },
    });

    const cleared = await testContext.store.update(optedIn.server.id, { identity: null });
    expect(cleared.kind).toBe('updated');
    await expect(testContext.store.resolveIdentityKey(optedIn.server.id)).resolves.toBeUndefined();
  });
}
