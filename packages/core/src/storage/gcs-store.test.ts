import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import {
  createGcsObjectStore,
  createGcsObjectStoreProvider,
  type GcsClient,
  type GcsObjectContent,
  type GcsStoredObject,
} from './gcs-store.js';
import type { PutObjectInput } from './object-store.js';

interface FakeObject {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly contentTypeKnown: boolean;
  readonly lastModified: Date;
}

function createFakeGcsClient(): GcsClient & { readonly objects: Map<string, FakeObject> } {
  const objects = new Map<string, FakeObject>();
  let clock = 0;
  const metadata = (name: string, object: FakeObject): GcsStoredObject => ({
    name,
    sizeBytes: object.body.byteLength,
    contentType: object.contentType,
    contentTypeKnown: object.contentTypeKnown,
    lastModified: object.lastModified,
  });
  return {
    objects,
    write(name: string, input: PutObjectInput): Promise<void> {
      clock += 1;
      objects.set(name, {
        body: Uint8Array.from(input.body),
        contentType: input.contentType ?? null,
        contentTypeKnown: input.contentType !== undefined && input.contentType !== null,
        lastModified: new Date(clock * 1_000),
      });
      return Promise.resolve();
    },
    read(name: string): Promise<GcsObjectContent | null> {
      const object = objects.get(name);
      return Promise.resolve(
        object === undefined ? null : { ...metadata(name, object), body: object.body },
      );
    },
    delete(name: string): Promise<void> {
      objects.delete(name);
      return Promise.resolve();
    },
    list(prefix: string): Promise<readonly GcsStoredObject[]> {
      return Promise.resolve(
        [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, object]) => metadata(name, object)),
      );
    },
    copy(sourceName: string, destinationName: string): Promise<void> {
      const source = objects.get(sourceName);
      if (source !== undefined) {
        clock += 1;
        objects.set(destinationName, {
          ...source,
          body: Uint8Array.from(source.body),
          lastModified: new Date(clock * 1_000),
        });
      }
      return Promise.resolve();
    },
  };
}

function setup(): Promise<ObjectStoreContractFixture> {
  const client = createFakeGcsClient();
  return Promise.resolve({
    provider: createGcsObjectStoreProvider({ client }),
    teardown: () => {
      client.objects.clear();
      return Promise.resolve();
    },
  });
}

defineObjectStoreContract('Google Cloud Storage (offline fake)', setup);

describe('GCS deployment prefixes', () => {
  it('keeps files and skills in separate prefixes while both round-trip', async () => {
    const client = createFakeGcsClient();
    const files = createGcsObjectStoreProvider({ client, keyPrefix: 'files' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    const skills = createGcsObjectStoreProvider({ client, keyPrefix: 'skills' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    await files.put('shared.txt', { body: new TextEncoder().encode('file') });
    await skills.put('shared.txt', { body: new TextEncoder().encode('skill') });

    expect(new TextDecoder().decode((await files.get('shared.txt'))?.body)).toBe('file');
    expect(new TextDecoder().decode((await skills.get('shared.txt'))?.body)).toBe('skill');
    expect([...client.objects.keys()].sort()).toEqual([
      'files/workspaces/11111111-1111-4111-8111-111111111111/shared.txt',
      'skills/workspaces/11111111-1111-4111-8111-111111111111/shared.txt',
    ]);
  });

  it('ignores foreign placeholder and encoded names without hiding addressable objects', async () => {
    const client = createFakeGcsClient();
    const store = createGcsObjectStoreProvider({ client, keyPrefix: 'files' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    const foreignObject: FakeObject = {
      body: new Uint8Array(),
      contentType: null,
      contentTypeKnown: false,
      lastModified: new Date(1_000),
    };
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/reports/',
      foreignObject,
    );
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/foreign%name.txt',
      foreignObject,
    );
    await store.put('visible.txt', { body: new TextEncoder().encode('visible') });

    await expect(store.list('')).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
    await expect(store.listPrefix('')).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
  });

  it('lists every object of the raw store under an empty prefix, in code-unit order', async () => {
    const store = createGcsObjectStore({ client: createFakeGcsClient() });
    for (const key of ['b.txt', 'a/z.txt', 'B.txt']) {
      await store.put(key, { body: new TextEncoder().encode(key) });
    }

    const listed = await store.listPrefix('');

    expect(listed.map((entry) => entry.key)).toEqual(['B.txt', 'a/z.txt', 'b.txt']);
  });
});
