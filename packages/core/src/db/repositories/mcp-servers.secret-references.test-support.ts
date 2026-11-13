import crypto from 'node:crypto';

import { STORAGE_CONNECTION_SECRET_PREFIX } from '@indx-workspace/contracts/secret-reference';
import { expect, it } from 'vitest';

import { modelConnections } from '../schema/model-connections.js';
import { storageConnections } from '../schema/storage-connections.js';
import {
  created,
  httpConnector,
  type McpServerFixture,
} from './mcp-servers.fixture.test-support.js';

const noReferrers = { connectorIds: [], modelConnectionIds: [], storageConnectionIds: [] };

async function seal(fixture: McpServerFixture, name: string, value: string): Promise<string> {
  const sealed = await fixture.secretsService.create(fixture.scopeA, {
    name,
    value: Buffer.from(value, 'utf8'),
  });
  return created(sealed).secret.id;
}

/** A connector holding a secret: the delete is refused, naming the connector. */
async function connectorHoldsSecret(fixture: McpServerFixture) {
  const { secretsService } = fixture;
  const secretId = await seal(fixture, 'REFERENCED_BY_CONNECTOR', 'referenced-value');
  const { server } = created(
    await fixture.repo(fixture.scopeA).create(
      httpConnector({
        name: 'Holds a credential',
        url: 'https://mcp.example.test/credentialed',
        authType: 'bearer',
        credentialSecretId: secretId,
        ownerPrincipalId: fixture.principalA,
        createdBy: fixture.userA,
      }),
    ),
  );

  // Another workspace cannot even find it; the referenced secret stays.
  await expect(secretsService.delete(fixture.scopeB, secretId)).resolves.toEqual({
    kind: 'not-found',
  });
  const refused = await secretsService.delete(fixture.scopeA, secretId);
  expect(refused).toEqual({
    kind: 'in-use',
    referrers: { ...noReferrers, connectorIds: [server.id] },
  });
  expect(JSON.stringify(refused)).not.toContain('referenced-value');
  return { secretId, connectorId: server.id };
}

/** A model connection owns the secret its id names, by the MODEL_CONNECTION_* convention. */
async function modelConnectionOwnsSecret(fixture: McpServerFixture): Promise<void> {
  const modelConnectionId = crypto.randomUUID();
  const secretId = await seal(
    fixture,
    `MODEL_CONNECTION_${modelConnectionId.replace(/-/g, '').toUpperCase()}`,
    'model-key',
  );
  await fixture.isolated.db.insert(modelConnections).values({
    id: modelConnectionId,
    workspaceId: fixture.workspaceA.id,
    name: 'Model connection',
    provider: 'anthropic',
    config: {},
  });
  await expect(fixture.secretsService.delete(fixture.scopeA, secretId)).resolves.toEqual({
    kind: 'in-use',
    referrers: { ...noReferrers, modelConnectionIds: [modelConnectionId] },
  });
}

/** A storage connection owns the secret its id names, by the STORAGE_CONNECTION_* convention. */
async function storageConnectionOwnsSecret(fixture: McpServerFixture): Promise<void> {
  const { secretsService, scopeA } = fixture;
  const storageConnectionId = crypto.randomUUID();
  const secretId = await seal(
    fixture,
    `${STORAGE_CONNECTION_SECRET_PREFIX}${storageConnectionId.replace(/-/g, '').toUpperCase()}`,
    'storage-key',
  );
  await fixture.isolated.db.insert(storageConnections).values({
    id: storageConnectionId,
    workspaceId: fixture.workspaceA.id,
    name: 'Storage connection',
    provider: 's3',
    url: 's3://bucket/exports',
    allowedPrefixes: [],
  });
  await expect(secretsService.delete(scopeA, secretId)).resolves.toEqual({
    kind: 'in-use',
    referrers: { ...noReferrers, storageConnectionIds: [storageConnectionId] },
  });
  // Once the connection row is gone the secret is an orphan, and a delete clears it.
  await fixture.isolated.db.delete(storageConnections);
  await expect(secretsService.delete(scopeA, secretId)).resolves.toMatchObject({
    kind: 'deleted',
  });
}

/** Deleting a secret that a connector, model connection or storage connection still references. */
export function registerSecretReferenceCases(fixture: McpServerFixture): void {
  it('refuses to delete a secret a connector or a model connection references, naming both (#240)', async () => {
    const { secretsService, scopeA } = fixture;
    const { secretId, connectorId } = await connectorHoldsSecret(fixture);
    await modelConnectionOwnsSecret(fixture);
    await storageConnectionOwnsSecret(fixture);

    // Once the connector stops referencing it, the delete succeeds and the row is gone.
    await expect(fixture.repo(scopeA).delete(connectorId)).resolves.toEqual({ kind: 'deleted' });
    await expect(secretsService.delete(scopeA, secretId)).resolves.toMatchObject({
      kind: 'deleted',
      secret: { id: secretId },
    });
    const remaining = await secretsService.list(scopeA);
    expect(remaining.map((secret) => secret.id)).not.toContain(secretId);
  });
}
