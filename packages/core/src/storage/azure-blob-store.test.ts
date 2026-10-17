import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract } from './contract.js';
import {
  createAzureBlobObjectStoreProvider,
  createAzureBlobObjectStoreProviderFromConfig,
  type AzureBlobContainer,
  type AzureBlobEntry,
  type AzureBlobFileEntry,
} from './azure-blob-store.js';
import type { ObjectContent, PutObjectInput } from './object-store.js';

function fakeAzureBlobContainer(): AzureBlobContainer {
  const values = new Map<string, ObjectContent>();
  const clone = (value: ObjectContent): ObjectContent => ({
    ...value,
    body: Buffer.from(value.body),
  });
  return {
    assertReady: () => Promise.resolve(),
    put(name: string, input: PutObjectInput): Promise<void> {
      values.set(name, {
        body: Buffer.from(input.body),
        contentType: input.contentType ?? null,
        sizeBytes: input.body.byteLength,
        lastModified: new Date('2026-09-23T00:00:00.000Z'),
      });
      return Promise.resolve();
    },
    get(name: string): Promise<ObjectContent | null> {
      const value = values.get(name);
      return Promise.resolve(value === undefined ? null : clone(value));
    },
    delete(name: string): Promise<void> {
      values.delete(name);
      return Promise.resolve();
    },
    listHierarchy(prefix: string): Promise<readonly AzureBlobEntry[]> {
      const entries = new Map<string, AzureBlobEntry>();
      for (const [name, value] of values) {
        if (!name.startsWith(prefix)) continue;
        const relative = name.slice(prefix.length);
        if (relative === '') continue;
        const separator = relative.indexOf('/');
        if (separator >= 0) {
          const folderName = `${prefix}${relative.slice(0, separator)}`;
          entries.set(folderName, { kind: 'folder', name: folderName });
          continue;
        }
        entries.set(name, {
          kind: 'file',
          name,
          sizeBytes: value.sizeBytes,
          contentType: value.contentType,
          lastModified: value.lastModified,
        });
      }
      return Promise.resolve([...entries.values()]);
    },
    listFlat(prefix: string): Promise<readonly AzureBlobFileEntry[]> {
      return Promise.resolve(
        [...values.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, value]) => ({
            kind: 'file' as const,
            name,
            sizeBytes: value.sizeBytes,
            contentType: value.contentType,
            lastModified: value.lastModified,
          })),
      );
    },
  };
}

defineObjectStoreContract('Azure Blob (fake)', () =>
  Promise.resolve({
    provider: createAzureBlobObjectStoreProvider(fakeAzureBlobContainer()),
    teardown: () => Promise.resolve(),
  }),
);

describe('Azure Blob prefix placement', () => {
  it.each(['files', 'skills'])('round-trips through the %s prefix', async (prefix) => {
    const store = createAzureBlobObjectStoreProvider(fakeAzureBlobContainer(), prefix).forWorkspace(
      'workspace-a',
    );
    await store.put('resource.bin', { body: Buffer.from('native-azure') });
    expect((await store.get('resource.bin'))?.body.toString()).toBe('native-azure');
  });

  it('refuses a SAS-bearing service URL before contacting Azure', async () => {
    await expect(
      createAzureBlobObjectStoreProviderFromConfig({
        serviceUrl: 'https://account.blob.core.windows.net/?sv=2026-01-01&sig=secret',
        container: 'workspace-objects',
      }),
    ).rejects.toThrow(/without credentials, a SAS query, a path or a fragment/u);
  });
});
