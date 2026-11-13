// @story US-STO-12
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  MEMBER_ACCESS,
  readOnlyStore,
  ReadOnlyStoreError,
  type ConnectionCredential,
} from './connection-store.js';
import {
  bytes,
  codeOf,
  open,
  s3Credential,
  tempRoot,
} from './connection-store.fixture.test-support.js';
import { pinnedLookup } from './connection-pinning.js';
import {
  defineObjectStoreContract,
  defineOwnPagingContract,
  type ObjectStoreContractFixture,
} from './contract.js';
import { createInMemoryObjectStore } from './memory-store.js';
import { scopedObjectStoreProvider, type ObjectStore } from './object-store.js';
import { streamToBytes } from './streams.js';

describe('openConnectionStore', () => {
  it('[US-STO-12][unit][sdk] a file:// connection lists and reads the files already in the folder', async () => {
    const root = await tempRoot();
    try {
      await mkdir(path.join(root, 'reports', '2026'), { recursive: true });
      await writeFile(path.join(root, 'reports', 'a.txt'), 'alpha');
      await writeFile(path.join(root, 'reports', '2026', 'b.txt'), 'bravo');
      const store = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });

      const page = await store.listPage('reports');
      expect(page.entries).toMatchObject([
        { kind: 'folder', key: 'reports/2026' },
        { kind: 'file', key: 'reports/a.txt', sizeBytes: 5, contentType: 'text/plain' },
      ]);
      const read = await store.read('reports/2026/b.txt');
      expect(new TextDecoder().decode(await streamToBytes(read!.body))).toBe('bravo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] a read-only connection store throws ReadOnlyStoreError on write', async () => {
    const root = await tempRoot();
    try {
      const store = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });
      await expect(store.write('a.txt', bytes, {})).rejects.toBeInstanceOf(ReadOnlyStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] every non-read member of ObjectStore is refused when read-only', async () => {
    type WriteMember = {
      [K in keyof typeof MEMBER_ACCESS]: (typeof MEMBER_ACCESS)[K] extends 'write' ? K : never;
    }[keyof typeof MEMBER_ACCESS];
    const calls: Record<WriteMember, (store: ObjectStore) => Promise<unknown>> = {
      delete: (store) => store.delete('a.txt'),
      copy: (store) => store.copy('a.txt', 'b.txt'),
      write: (store) => store.write('a.txt', bytes, {}),
    };
    const store = readOnlyStore(createInMemoryObjectStore());
    for (const [member, access] of Object.entries(MEMBER_ACCESS)) {
      if (access !== 'write') continue;
      const call = calls[member as WriteMember];
      await expect(call(store)).rejects.toBeInstanceOf(ReadOnlyStoreError);
    }
    expect(await store.head('a.txt')).toBeNull();
  });

  // #1991 A4: a refused streamed write still releases the caller's source.
  it('[US-STO-12][unit][sdk] refusing a read-only write cancels its unopened source', async () => {
    const backend = createInMemoryObjectStore();
    const write = vi.spyOn(backend, 'write');
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });

    const refusal: unknown = await readOnlyStore(backend)
      .write('a.txt', source, {})
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ReadOnlyStoreError);
    expect(cancel).toHaveBeenCalledWith(refusal);
    expect(write).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][sdk] a failed cancel keeps both the refusal and the cancel failure', async () => {
    const cancelFailure = new Error('source cancel failed');
    const source = new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(cancelFailure) });

    const error: unknown = await readOnlyStore(createInMemoryObjectStore())
      .write('a.txt', source, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors;
    expect(errors[0]).toBeInstanceOf(ReadOnlyStoreError);
    expect(errors[1]).toBe(cancelFailure);
    expect((error as AggregateError).cause).toBe(cancelFailure);
  });

  it('[US-STO-12][unit][sdk] a signed PUT URL is refused and a signed GET URL is not', async () => {
    const sign = vi.fn(() => Promise.resolve({ url: 'https://store.example/k', headers: {} }));
    const store = readOnlyStore({ ...createInMemoryObjectStore(), createSignedUrl: sign });
    await expect(store.createSignedUrl?.('k', { method: 'PUT' })).rejects.toBeInstanceOf(
      ReadOnlyStoreError,
    );
    expect(sign).not.toHaveBeenCalled();
    await expect(store.createSignedUrl?.('k', { method: 'GET' })).resolves.toMatchObject({
      url: 'https://store.example/k',
    });
    expect('createSignedUrl' in readOnlyStore(createInMemoryObjectStore())).toBe(false);
  });

  it('[US-STO-12][unit][sdk] a read-only connection still reads, and a writable one writes', async () => {
    const root = await tempRoot();
    try {
      const writable = await open(
        `file://${root}`,
        { provider: 'file' },
        { fileRoots: [root], writable: true },
      );
      await writable.write('a.txt', bytes, {});
      const readOnly = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });
      expect((await readOnly.head('a.txt'))?.sizeBytes).toBe(3);
      expect((await readOnly.listPage('')).entries.map((entry) => entry.key)).toContain('a.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] an aborted signal stops the open and the listing', async () => {
    const root = await tempRoot();
    try {
      const aborted = AbortSignal.abort();
      const file = { provider: 'file' } as const;
      await expect(
        open(`file://${root}`, file, { fileRoots: [root], signal: aborted }),
      ).rejects.toBe(aborted.reason);
      const store = await open(`file://${root}`, file, { fileRoots: [root] });
      await expect(store.listPage('', { signal: aborted })).rejects.toBe(aborted.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] file connections stay under the allowed roots', async () => {
    const base = await tempRoot();
    try {
      const root = path.join(base, 'root');
      const sibling = path.join(base, 'rootX');
      const outside = path.join(base, 'outside');
      const inside = path.join(root, 'team');
      await Promise.all([inside, sibling, outside].map((dir) => mkdir(dir, { recursive: true })));
      await symlink(outside, path.join(root, 'escape'));
      const file = { provider: 'file' } as const;
      const attempt = (target: string, fileRoots: readonly string[] = [root]): Promise<unknown> =>
        open(`file://${target}`, file, { fileRoots });

      await expect(attempt(inside)).resolves.toBeDefined();
      await expect(attempt(root)).resolves.toBeDefined();
      await expect(attempt(inside, [`${root}/../root`])).resolves.toBeDefined();
      const refused = await Promise.all(
        [
          attempt(outside),
          attempt(sibling),
          attempt(path.join(root, 'escape')),
          attempt(path.join(inside, 'missing')),
          attempt(inside, []),
          attempt(inside, [path.join(base, 'missing-root')]),
        ].map(codeOf),
      );
      expect(new Set(refused)).toEqual(new Set(['storage_connection_endpoint_forbidden']));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] a URL with a secret, a bad URL and the wrong credential are refused', async () => {
    const credential = s3Credential();
    expect(await codeOf(open(`s3://acme-data:${credential.provider}@x`, credential))).toBe(
      'storage_connection_url_has_secret',
    );
    expect(await codeOf(open('ftp://acme-data', credential))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('gcs://acme-data', credential))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('s3://acme-data', { provider: 'file' }))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('s3://acme-data', { provider: 's3' } as ConnectionCredential))).toBe(
      'storage_connection_url_invalid',
    );
  });
});

describe('connection store endpoint guard', () => {
  const resolveTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(
        addresses.map((address) => ({
          address,
          family: address.includes(':') ? (6 as const) : (4 as const),
        })),
      );

  it.each([
    ['http://s3.example.com', ['93.184.216.34']],
    ['https://127.0.0.1', []],
    ['https://169.254.169.254', []],
    ['https://10.0.0.1', []],
    ['https://100.64.0.1', []],
    ['https://[fd00::1]', []],
    ['https://0.0.0.0', []],
    ['https://[::]', []],
    ['https://[::ffff:10.0.0.1]', []],
    ['https://2130706433', []],
    ['https://0177.0.0.1', []],
    ['https://s3.example.com', ['93.184.216.34', '10.0.0.7']],
    ['https://s3.example.com', ['93.184.216.34', '::ffff:169.254.169.254']],
  ])('[US-STO-12][unit][sdk] private endpoints are refused: %s %j', async (endpoint, resolved) => {
    const url = formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint,
      forcePathStyle: true,
    });
    const credential = s3Credential();
    expect(await codeOf(open(url, credential, { resolve: resolveTo(...resolved) }))).toBe(
      'storage_connection_endpoint_forbidden',
    );
  });

  // #1835: a signed link names the public endpoint, and whatever fetches it (a browser, a runner)
  // must not be pointed at a private address through the connection URL.
  it('[US-STO-12][unit][sdk] a private publicEndpoint is refused like a private endpoint', async () => {
    const urlWith = (publicEndpoint: string): string =>
      formatStorageUrl({
        kind: 's3',
        bucket: 'acme-data',
        prefix: '',
        publicEndpoint,
        forcePathStyle: false,
      });
    const resolve = resolveTo('93.184.216.34');
    expect(
      await codeOf(open(urlWith('https://169.254.169.254'), s3Credential(), { resolve })),
    ).toBe('storage_connection_endpoint_forbidden');
    expect(
      await codeOf(open(urlWith('https://cdn.example.com'), s3Credential(), { resolve })),
    ).toBeUndefined();
  });

  // #1835: the default Azure host goes through the same check as an `endpoint=` one, so a name the
  // operator's resolver maps to a private address is refused, and the sockets are pinned.
  it('[US-STO-12][unit][sdk] the default Azure account host is checked too', async () => {
    const url = formatStorageUrl({
      kind: 'azblob',
      account: 'acme',
      serviceUrl: 'https://acme.blob.core.windows.net',
      container: 'files',
      prefix: '',
    });
    const asked: string[] = [];
    const resolve = (host: string) => {
      asked.push(host);
      return resolveTo('10.0.0.7')();
    };
    expect(
      await codeOf(open(url, { provider: 'azblob', sasToken: 'sv=1&sig=x' }, { resolve })),
    ).toBe('storage_connection_endpoint_forbidden');
    expect(asked).toEqual(['acme.blob.core.windows.net']);
  });

  it('[US-STO-12][unit][sdk] the pinned lookup answers only with the checked addresses', async () => {
    const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    const single = await new Promise((resolve) => {
      lookup('anything.example', {}, (_error, address, family) => resolve({ address, family }));
    });
    expect(single).toEqual({ address: '93.184.216.34', family: 4 });
    const all = await new Promise((resolve) => {
      lookup('anything.example', { all: true }, (_error, addresses) => resolve(addresses));
    });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('[US-STO-12][unit][sdk] the pinned lookup answers a family request only from that family', async () => {
    const lookup = pinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    const ask = (options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean }) =>
      new Promise<unknown>((resolve) => {
        lookup('anything.example', options, (error, address, family) =>
          resolve(
            error === null ? { address, family } : { code: (error as { code?: string }).code },
          ),
        );
      });
    expect(await ask({ family: 6 })).toEqual({ address: '2606:2800:220:1::1', family: 6 });
    expect(await ask({ family: 'IPv6' })).toEqual({ address: '2606:2800:220:1::1', family: 6 });
    expect(await ask({ family: 4 })).toEqual({ address: '93.184.216.34', family: 4 });
    expect(await ask({ family: 6, all: true })).toEqual({
      address: [{ address: '2606:2800:220:1::1', family: 6 }],
      family: undefined,
    });
    const v4Only = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    const refused = await new Promise<unknown>((resolve) => {
      v4Only('anything.example', { family: 6 }, (error) =>
        resolve((error as { code?: string }).code),
      );
    });
    expect(refused).toBe('ENOTFOUND');
  });
});

const memoryContract = () =>
  Promise.resolve({
    provider: scopedObjectStoreProvider(createInMemoryObjectStore()),
    teardown: () => Promise.resolve(),
  });
defineObjectStoreContract('connection store — memory', memoryContract);
defineOwnPagingContract('connection store — memory', memoryContract);

const fileContract = async (): Promise<ObjectStoreContractFixture> => {
  const root = await tempRoot();
  const store = await open(
    `file://${root}`,
    { provider: 'file' },
    { writable: true, fileRoots: [root] },
  );
  return {
    provider: scopedObjectStoreProvider(store),
    teardown: () => rm(root, { recursive: true, force: true }),
    // A connected folder has no sidecar: the type comes from the file name.
    contentTypeFromName: true,
    plantRaw: async (key, planted) => {
      const target = path.join(root, key);
      if (key.endsWith('/')) {
        await mkdir(target, { recursive: true });
        return;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, planted);
    },
  };
};
defineObjectStoreContract('connection store — file', fileContract);
defineOwnPagingContract('connection store — file', fileContract);
