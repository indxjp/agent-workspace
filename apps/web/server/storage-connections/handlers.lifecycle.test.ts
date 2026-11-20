/**
 * The storage-connection lifecycle (change, rotate and delete), driven through the routes over the
 * in-memory repository and over PostgreSQL (the storage design, §05 and §06 Phase 5).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { StorageConnectionResourceSchema } from '@indx-workspace/contracts/storage-connections';

import {
  audits,
  body,
  change,
  connect,
  expectAudit,
  expectError,
  fileRoot,
  granted,
  storedCredential,
  useStorageConnectionRoutes,
  WORKSPACE_A,
  WORKSPACE_B,
} from './handlers.test-support';
import {
  expectNoCredential,
  readOne,
  REPOSITORY_KINDS,
  rotated,
  useLifecycleRepository,
  type RepositoryKind,
} from './handlers.lifecycle.test-support';

useStorageConnectionRoutes();

function registerChangeTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] an admin renames a connection and narrows its folders', async () => {
    const id = await connect({ ...body, name: `rename-${kind}` });
    const response = await change('PATCH', id, {
      name: `renamed-${kind}`,
      url: 's3://acme-other/exports',
      allowedPrefixes: ['reports/2026'],
      writeAllowed: true,
      credential: rotated,
    });
    expect(response.status).toBe(200);
    expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
      id,
      name: `renamed-${kind}`,
      url: 's3://acme-other/exports',
      allowedPrefixes: ['reports/2026'],
      writeAllowed: true,
      hasCredential: true,
    });
    expect(await storedCredential(id)).toEqual(rotated);
    expectAudit('storage-connection-updated', id, `renamed-${kind}`);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] the stored credential never follows a connection to another endpoint, account or bucket', async () => {
    const id = await connect({ ...body, name: `pinned-${kind}` });
    const before: unknown = await (await readOne(id)).json();
    const moves = [
      's3://acme-data/exports?endpoint=https://attacker.example',
      's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com&publicEndpoint=https://attacker.example',
      's3://acme-data/exports',
      's3://acme-other/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
    ];
    for (const url of moves) {
      const response = await change('PATCH', id, { url, allowedPrefixes: ['other'] });
      await expectError(response, 409, 'storage_connection_credential_required');
    }
    const mismatch = await change('PATCH', id, {
      url: moves[0],
      credential: { provider: 'gcs', serviceAccountJson: '{}' },
    });
    expect(mismatch.status).toBe(422);
    expect(await (await readOne(id)).json()).toEqual(before);
    expect(await storedCredential(id)).toEqual(body.credential);
    expect(audits).toHaveLength(1);

    const moved = await change('PATCH', id, { url: moves[0], credential: rotated });
    expect(moved.status).toBe(200);
    const text = await moved.text();
    expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
      url: moves[0],
      hasCredential: true,
    });
    expect(await storedCredential(id)).toEqual(rotated);
    expectNoCredential(text);
  });
}

function registerRefusalTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a prefix, name or write change keeps the stored credential', async () => {
    const id = await connect({ ...body, name: `kept-${kind}` });
    const response = await change('PATCH', id, {
      name: `kept-renamed-${kind}`,
      url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
      allowedPrefixes: ['archive/2026'],
      writeAllowed: true,
    });
    expect(response.status).toBe(200);
    expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
      url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
      hasCredential: true,
    });
    expect(await storedCredential(id)).toEqual(body.credential);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a patch is refused for a taken name, another provider or a URL with a secret', async () => {
    const id = await connect({ ...body, name: `patched-${kind}` });
    await connect({ ...body, name: `taken-${kind}` });
    const refused = [
      [{ name: `taken-${kind}` }, 409, 'storage_connection_name_taken'],
      [{ url: 'gcs://acme-bucket/exports' }, 422, 'storage_connection_url_invalid'],
      [
        { url: pathToFileURL(path.join(fileRoot, 'shared')).href },
        422,
        'storage_connection_url_invalid',
      ],
      [{ url: 's3://acme-data@host/x' }, 422, 'storage_connection_url_has_secret'],
      [{}, 400, 'invalid_storage_connection'],
    ] as const;
    for (const [patchBody, status, code] of refused) {
      await expectError(await change('PATCH', id, patchBody), status, code);
    }
    expect(audits).toHaveLength(2);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a member cannot change, rotate or delete a connection', async () => {
    const id = await connect({ ...body, name: `guarded-${kind}` });
    const builder = { role: 'builder' } as const;
    expect((await change('PATCH', id, { writeAllowed: true }, builder)).status).toBe(403);
    expect((await change('PUT', id, rotated, builder)).status).toBe(403);
    expect((await change('DELETE', id, undefined, builder)).status).toBe(403);
    expect((await change('DELETE', id, undefined, { role: 'viewer' })).status).toBe(403);
    expect(await storedCredential(id)).toEqual(body.credential);
    expect(audits).toHaveLength(1);
  });
}

function registerRotateAndDeleteTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] rotating the credential replaces the secret and never returns it', async () => {
    const id = await connect({ ...body, name: `rotated-${kind}` });
    const response = await change('PUT', id, rotated);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
      id,
      hasCredential: true,
    });
    expect(await storedCredential(id)).toEqual(rotated);
    const mismatch = await change('PUT', id, { provider: 'gcs', serviceAccountJson: '{}' });
    expect(mismatch.status).toBe(422);
    expect(await storedCredential(id)).toEqual(rotated);
    expectNoCredential([text, JSON.stringify(audits)].join('\n'));
    expectAudit('storage-connection-credential-changed', id);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] rotating a connection created without a credential creates its secret', async () => {
    const id = await connect({ ...body, name: `bare-${kind}`, credential: undefined });
    expect(await storedCredential(id)).toBeNull();
    const response = await change('PUT', id, rotated);
    expect(response.status).toBe(200);
    expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
      id,
      hasCredential: true,
    });
    expect(await storedCredential(id)).toEqual(rotated);
    expectAudit('storage-connection-credential-changed', id);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] deleting a connection removes its row and then its secret', async () => {
    const id = await connect({ ...body, name: `doomed-${kind}` });
    expect((await change('DELETE', id)).status).toBe(204);
    expect((await readOne(id)).status).toBe(404);
    expect(await storedCredential(id)).toBeNull();
    expect((await change('DELETE', id)).status).toBe(404);
    expectAudit('storage-connection-deleted', id, `doomed-${kind}`);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a connection an agent version grants is not deleted', async () => {
    const id = await connect({ ...body, name: `granted-${kind}` });
    granted.add(`${WORKSPACE_A}/${id}`);
    await expectError(await change('DELETE', id), 409, 'storage_connection_in_use');
    expect((await readOne(id)).status).toBe(200);
    expect(await storedCredential(id)).toEqual(body.credential);
    expect(audits).toHaveLength(1);
    // Another workspace's grant of the same id does not hold this one.
    granted.clear();
    granted.add(`${WORKSPACE_B}/${id}`);
    expect((await change('DELETE', id)).status).toBe(204);
  });
}

function registerIsolationTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it.each([
    ['PATCH', { writeAllowed: true }],
    ['PUT', rotated],
    ['DELETE', undefined],
  ] as const)(
    '[US-STO-12][api][sdk] another workspace gets 404 on %s and changes nothing',
    async (method, payload) => {
      const id = await connect({ ...body, name: `private-${method.toLowerCase()}-${kind}` });
      const response = await change(method, id, payload, {
        role: 'owner',
        workspace: WORKSPACE_B,
      });
      await expectError(response, 404, 'storage_connection_not_found');
      expect(StorageConnectionResourceSchema.parse(await (await readOne(id)).json())).toMatchObject(
        {
          writeAllowed: false,
          hasCredential: true,
        },
      );
      expect(await storedCredential(id)).toEqual(body.credential);
      expect(audits).toHaveLength(1);
    },
  );

  // @story US-STO-12
  it('[US-STO-12][api][sdk] no response or audit row of the lifecycle holds a credential', async () => {
    const id = await connect({ ...body, name: `clean-${kind}` });
    const texts = [
      await (await change('PATCH', id, { writeAllowed: true })).text(),
      await (await change('PUT', id, rotated)).text(),
      await (await change('PUT', id, { provider: 's3' })).text(),
      await (await change('PATCH', id, { url: 's3://acme-data@host/x' })).text(),
      await (await readOne(id)).text(),
      await (await change('DELETE', id)).text(),
      JSON.stringify(audits),
    ].join('\n');
    expectNoCredential(texts);
  });
}

describe.each(REPOSITORY_KINDS)('storage connection lifecycle over the %s repository', (kind) => {
  useLifecycleRepository(kind);
  describe('PATCH/PUT/DELETE', () => {
    registerChangeTests(kind);
    registerRefusalTests(kind);
    registerRotateAndDeleteTests(kind);
    registerIsolationTests(kind);
  });
});
