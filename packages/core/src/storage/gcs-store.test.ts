import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectKeyContract,
  type ObjectStoreContractFixture,
} from './contract.js';
import { createFakeGcsClient, type FakeObject } from './gcs-store.fake.test-support.js';
import {
  createFakeGcsObjectStore,
  createGcsObjectStore,
  createGcsObjectStoreProvider,
} from './gcs-store.js';
import { listAll, readWhole } from './streams.js';

function setup(): Promise<ObjectStoreContractFixture> {
  const client = createFakeGcsClient();
  return Promise.resolve({
    provider: createGcsObjectStoreProvider({ client }),
    teardown: () => {
      client.objects.clear();
      return Promise.resolve();
    },
    plantRaw: async (key, bytes) => {
      await client.writeStream(key, bytes, {});
    },
  });
}

defineObjectStoreContract('Google Cloud Storage (offline fake)', setup);

// The real SDK adapter against fake-gcs-server over HTTP. The live acceptance fixture stays the
// proof for Google Cloud Storage itself (the emulator does not verify signatures).
//
// Only the keys-and-tenants contract: on each page of a delimited listing fake-gcs-server 1.56.1
// returns every common prefix at or after the page's start, uncapped, so a prefix that sorts after
// the page's items comes back on every later page, and it does not count prefixes against
// maxResults (GCS counts items and prefixes together). The full contract's paging case therefore
// fails on the emulator, not on the store.
// The read and write paths over this emulator are exercised by tests/load/object-store-round-trip.
const gcsEndpoint = process.env['TEST_GCS_ENDPOINT']?.trim() ?? '';
if (gcsEndpoint !== '') {
  // The factory tests/load opens its store with, so this leg also proves it.
  const setupEmulator = (): Promise<ObjectStoreContractFixture> =>
    createFakeGcsObjectStore(gcsEndpoint);
  defineObjectKeyContract('Google Cloud Storage (fake-gcs-server)', setupEmulator);

  // Owner decision (c) on #1746: a foreign `name/` placeholder object (a console "create folder")
  // is hidden: never a file entry, and the folder it implies lists as empty, as on S3 and Azure.
  it('hides a foreign folder placeholder object from every fake-gcs-server listing', async () => {
    const { provider, teardown, plantRaw } = await createFakeGcsObjectStore(gcsEndpoint);
    try {
      const workspace = '11111111-1111-4111-8111-111111111111';
      const store = provider.forWorkspace(workspace);
      await store.write('docs/real.txt', new TextEncoder().encode('real'), {});
      await plantRaw(`workspaces/${workspace}/docs/console-folder/`, new Uint8Array());
      await plantRaw(`workspaces/${workspace}/docs/console-folder/inner/`, new Uint8Array());

      const keys = async (prefix: string, recursive: boolean): Promise<string[]> =>
        (await listAll(store, prefix, { recursive })).map((entry) => `${entry.kind}:${entry.key}`);
      await expect(keys('docs', true)).resolves.toEqual(['file:docs/real.txt']);
      await expect(keys('docs', false)).resolves.toEqual([
        'folder:docs/console-folder',
        'file:docs/real.txt',
      ]);
      await expect(keys('docs/console-folder', true)).resolves.toEqual([]);
      await expect(keys('docs/console-folder', false)).resolves.toEqual([
        'folder:docs/console-folder/inner',
      ]);
    } finally {
      await teardown();
    }
  });

  it('copy() copies bytes and content type on fake-gcs-server and ignores a missing source', async () => {
    const { provider, teardown } = await setupEmulator();
    try {
      const store = provider.forWorkspace('11111111-1111-4111-8111-111111111111');
      await store.write('from.txt', new TextEncoder().encode('payload'), {
        contentType: 'text/plain',
      });
      await store.copy('from.txt', 'to.txt');
      await store.copy('gone.txt', 'never.txt');
      expect(await store.head('to.txt')).toMatchObject({ sizeBytes: 7, contentType: 'text/plain' });
      expect(await store.head('from.txt')).not.toBeNull();
      expect(await store.head('never.txt')).toBeNull();
    } finally {
      await teardown();
    }
  });
}

describe('GCS deployment prefixes', () => {
  it('keeps files and skills in separate prefixes while both round-trip', async () => {
    const client = createFakeGcsClient();
    const files = createGcsObjectStoreProvider({ client, keyPrefix: 'files' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    const skills = createGcsObjectStoreProvider({ client, keyPrefix: 'skills' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    await files.write('shared.txt', new TextEncoder().encode('file'), {});
    await skills.write('shared.txt', new TextEncoder().encode('skill'), {});

    expect(new TextDecoder().decode((await readWhole(files, 'shared.txt'))?.body)).toBe('file');
    expect(new TextDecoder().decode((await readWhole(skills, 'shared.txt'))?.body)).toBe('skill');
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
      generation: 1,
    };
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/reports/',
      foreignObject,
    );
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/foreign%name.txt',
      foreignObject,
    );
    await store.write('visible.txt', new TextEncoder().encode('visible'), {});

    // A delimited listing reports the placeholder's prefix as a folder, as S3 and Azure do.
    await expect(listAll(store, '')).resolves.toEqual([
      { kind: 'folder', key: 'reports' },
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
    await expect(listAll(store, '', { recursive: true })).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
  });

  it('lists every object of the raw store under an empty prefix, in code-unit order', async () => {
    const store = createGcsObjectStore({ client: createFakeGcsClient() });
    for (const key of ['b.txt', 'a/z.txt', 'B.txt']) {
      await store.write(key, new TextEncoder().encode(key), {});
    }

    const { entries: listed } = await store.listPage('', { recursive: true });

    expect(listed.map((entry) => entry.key)).toEqual(['B.txt', 'a/z.txt', 'b.txt']);
  });
});
