import { Readable } from 'node:stream';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { UnsafeObjectKeyError } from './key-safety.js';
import { createInMemoryObjectStore } from './memory-store.js';
import {
  clampListLimit,
  createScopedObjectStore,
  type ListPageOptions,
  type ObjectStore,
  type SignedUrlRequest,
  SignedUrlUnsupportedError,
  scopedObjectStoreProvider,
} from './object-store.js';
import { streamToBytes, toNodeReadable, toWebStream } from './streams.js';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

describe('clampListLimit', () => {
  it('clampListLimit bounds', () => {
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-1)).toBe(1);
    expect(clampListLimit(5000)).toBe(1000);
    expect(clampListLimit(Number.NaN)).toBe(1000);
    expect(clampListLimit(undefined)).toBe(1000);
    expect(clampListLimit(2.9)).toBe(2);
    expect(clampListLimit(500)).toBe(500);
  });
});

describe('scoped listPage', () => {
  it('clamps the limit and strips the workspace prefix', async () => {
    const raw = createInMemoryObjectStore();
    const seen: (ListPageOptions | undefined)[] = [];
    const spy: ObjectStore = {
      ...raw,
      listPage: (prefix, options) => {
        seen.push(options);
        return raw.listPage(prefix, options);
      },
    };
    const store = createScopedObjectStore(spy, WORKSPACE_ID);
    await store.write('p/a.txt', new Uint8Array([1]), {});

    const page = await store.listPage('p', { limit: 5000 });

    expect(seen[0]?.limit).toBe(1000);
    expect(page.entries.map((entry) => entry.key)).toEqual(['p/a.txt']);
  });

  it('continues a scoped listing from its own cursor until the last page', async () => {
    const store = createScopedObjectStore(createInMemoryObjectStore(), WORKSPACE_ID);
    for (const name of ['a', 'b', 'c']) {
      await store.write(`p/${name}.txt`, new Uint8Array([1]), {});
    }

    const keys: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.listPage('p', {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.entries.map((entry) => entry.key));
      if (page.cursor === null) break;
      cursors.push(page.cursor);
      cursor = page.cursor;
    }

    expect(keys).toEqual(['p/a.txt', 'p/b.txt', 'p/c.txt']);
    expect(cursors).toHaveLength(2);
    for (const seen of cursors) {
      expect(seen).not.toContain(WORKSPACE_ID);
      expect(seen).not.toContain('workspaces/');
    }
  });
});

describe('node stream adapters', () => {
  it('toWebStream round-trips a Readable', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    expect(Buffer.from(await streamToBytes(toWebStream(source))).toString()).toBe('abcd');
  });

  it('toWebStream errors on a non-byte chunk', async () => {
    const source = Readable.from(['text'], { objectMode: true });
    await expect(streamToBytes(toWebStream(source))).rejects.toThrow(TypeError);
  });

  it('destroying toNodeReadable cancels the source stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const readable = toNodeReadable(body);
    await new Promise<void>((resolve) => {
      readable.once('close', resolve);
      readable.destroy();
    });
    expect(cancelled).toBe(true);
  });
});

describe('createScopedObjectStore', () => {
  it('scoped write cancels the body on an unsafe key', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const store = createScopedObjectStore(createInMemoryObjectStore(), WORKSPACE_ID);

    await expect(store.write('../x', body, {})).rejects.toThrow(UnsafeObjectKeyError);
    expect(cancelled).toBe(true);
  });
});

describe('scoped createSignedUrl', () => {
  function signingBackend(boundLengthSign: boolean): {
    readonly backend: ObjectStore;
    readonly seen: { key: string; request: SignedUrlRequest }[];
  } {
    const raw = createInMemoryObjectStore();
    const seen: { key: string; request: SignedUrlRequest }[] = [];
    const backend: ObjectStore = {
      ...raw,
      capabilities: { ...raw.capabilities, sign: true, boundLengthSign },
      createSignedUrl(key, request) {
        seen.push({ key, request });
        return Promise.resolve({ url: 'https://store.example/x', headers: {} });
      },
    };
    return { backend, seen };
  }

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] expiry above 900 s is refused before any I/O', async () => {
    const { backend, seen } = signingBackend(true);
    const store = createScopedObjectStore(backend, WORKSPACE_ID);

    await expect(
      store.createSignedUrl?.('a.txt', { method: 'GET', expiresInSeconds: 901 }),
    ).rejects.toThrow(SignedUrlUnsupportedError);
    expect(seen).toEqual([]);
  });

  // @story US-STO-05
  it('[US-STO-05][unit][sdk] default 300 s, max 900 s', async () => {
    const { backend, seen } = signingBackend(true);
    const store = createScopedObjectStore(backend, WORKSPACE_ID);

    await store.createSignedUrl?.('a.txt', { method: 'GET' });
    await store.createSignedUrl?.('a.txt', { method: 'GET', expiresInSeconds: 60 });
    await store.createSignedUrl?.('a.txt', { method: 'GET', expiresInSeconds: 900 });
    expect(seen.map((call) => call.request.expiresInSeconds)).toEqual([300, 60, 900]);

    for (const expiresInSeconds of [59, 901, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        store.createSignedUrl?.('a.txt', { method: 'GET', expiresInSeconds }),
      ).rejects.toThrow(SignedUrlUnsupportedError);
    }
    expect(seen).toHaveLength(3);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a bound length is refused centrally when it cannot be bound', async () => {
    const unable = signingBackend(false);
    const request = { method: 'PUT', contentLength: 3, requireBoundContentLength: true } as const;
    await expect(
      createScopedObjectStore(unable.backend, WORKSPACE_ID).createSignedUrl?.('up.bin', request),
    ).rejects.toThrow(SignedUrlUnsupportedError);
    expect(unable.seen).toEqual([]);

    const able = signingBackend(true);
    const store = createScopedObjectStore(able.backend, WORKSPACE_ID);
    await expect(
      store.createSignedUrl?.('up.bin', { method: 'PUT', requireBoundContentLength: true }),
    ).rejects.toThrow(SignedUrlUnsupportedError);
    await store.createSignedUrl?.('up.bin', request);
    expect(able.seen).toHaveLength(1);
  });

  // #1746: a far-future signing instant would mint a link that only becomes valid later, outliving
  // the 900 s bound. A past one only shortens the link, and the expired-link tests rely on it.
  // @story US-STO-05
  it('[US-STO-05][unit][sdk] a signing instant in the future is refused before any I/O', async () => {
    const { backend, seen } = signingBackend(true);
    const store = createScopedObjectStore(backend, WORKSPACE_ID);
    const inDays = new Date(Date.now() + 86_400_000);

    await expect(
      store.createSignedUrl?.('a.txt', { method: 'GET', now: inDays }),
    ).rejects.toThrowError(new SignedUrlUnsupportedError('The signing instant is in the future.'));
    await expect(
      store.createSignedUrl?.('a.txt', { method: 'GET', now: new Date(Number.NaN) }),
    ).rejects.toThrowError(
      new SignedUrlUnsupportedError('The signing instant is not a valid time.'),
    );
    expect(seen).toEqual([]);

    const past = new Date(Date.now() - 120_000);
    await store.createSignedUrl?.('a.txt', { method: 'GET', now: past });
    await store.createSignedUrl?.('a.txt', { method: 'GET', now: new Date() });
    expect(seen.map((call) => call.request.now)).toEqual([past, expect.any(Date)]);
  });
});

describe('the scoped store reaches its backend', () => {
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('only under the workspace prefix, and never for an unsafe key', async () => {
    const raw = createInMemoryObjectStore();
    const reached: string[] = [];
    const recording: ObjectStore = {
      ...raw,
      head(key) {
        reached.push(key);
        return raw.head(key);
      },
      read(key, options) {
        reached.push(key);
        return raw.read(key, options);
      },
      write(key, body, options) {
        reached.push(key);
        return raw.write(key, body, options);
      },
      listPage(prefix, options) {
        reached.push(prefix);
        return raw.listPage(prefix, options);
      },
    };
    const mine = createScopedObjectStore(recording, WORKSPACE_ID);
    const theirs = createScopedObjectStore(recording, '44444444-4444-4444-8444-444444444444');
    await theirs.write('d/secret.txt', utf8('theirs'), {});
    reached.length = 0;

    await mine.write('d/a.txt', utf8('mine'), {});
    expect(await mine.read('d/secret.txt')).toBeNull();
    expect(await mine.head('d/secret.txt')).toBeNull();
    expect((await mine.listPage('d')).entries.map((entry) => entry.key)).toEqual(['d/a.txt']);
    const everything = await mine.listPage('', { recursive: true });
    expect(everything.entries.map((entry) => entry.key)).toEqual(['d/a.txt']);
    expect(reached.length).toBeGreaterThan(0);
    for (const key of reached) expect(key.startsWith(`workspaces/${WORKSPACE_ID}`)).toBe(true);

    reached.length = 0;
    await expect(mine.write('../x', utf8('x'), {})).rejects.toThrow(UnsafeObjectKeyError);
    await expect(mine.read('../x')).rejects.toThrow(UnsafeObjectKeyError);
    await expect(mine.head('../x')).rejects.toThrow(UnsafeObjectKeyError);
    await expect(mine.listPage('../x')).rejects.toThrow(UnsafeObjectKeyError);
    expect(reached).toEqual([]);
  });
});

describe('ObjectStore port', () => {
  it('ObjectStore has no buffered members', () => {
    expectTypeOf<ObjectStore>().not.toHaveProperty('get');
    expectTypeOf<ObjectStore>().not.toHaveProperty('put');
    expectTypeOf<ObjectStore>().not.toHaveProperty('list');
    expectTypeOf<ObjectStore>().not.toHaveProperty('listPrefix');
    expectTypeOf<ObjectStore>().not.toHaveProperty('copyObject');
  });

  it('a scoped store and its provider hand out no buffered members', () => {
    const provider = scopedObjectStoreProvider(createInMemoryObjectStore());
    const store = createScopedObjectStore(createInMemoryObjectStore(), WORKSPACE_ID);
    expectTypeOf(store).toEqualTypeOf<ObjectStore>();
    expectTypeOf(provider.forWorkspace(WORKSPACE_ID)).toEqualTypeOf<ObjectStore>();
    for (const member of ['get', 'put', 'list', 'listPrefix']) {
      expect(member in store).toBe(false);
      expect(member in provider.forWorkspace(WORKSPACE_ID)).toBe(false);
    }
  });

  it('ObjectStore has a server-side copy', () => {
    expectTypeOf<ObjectStore>().toHaveProperty('copy');
  });
});
