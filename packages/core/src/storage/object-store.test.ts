import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { UnsafeObjectKeyError } from './key-safety.js';
import { createInMemoryObjectStore } from './memory-store.js';
import {
  clampListLimit,
  createScopedObjectStore,
  type ListPageOptions,
  type ObjectStore,
  type ObjectStoreV2,
  type SignedUrlRequest,
  SignedUrlUnsupportedError,
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
    const spy: ObjectStoreV2 = {
      ...raw,
      listPage: (prefix, options) => {
        seen.push(options);
        return raw.listPage(prefix, options);
      },
    };
    const store = createScopedObjectStore(spy, WORKSPACE_ID);
    await store.put('p/a.txt', { body: new Uint8Array([1]) });

    const page = await store.listPage('p', { limit: 5000 });

    expect(seen[0]?.limit).toBe(1000);
    expect(page.entries.map((entry) => entry.key)).toEqual(['p/a.txt']);
  });

  it('continues a scoped listing from its own cursor until the last page', async () => {
    const store = createScopedObjectStore(createInMemoryObjectStore(), WORKSPACE_ID);
    for (const name of ['a', 'b', 'c']) {
      await store.put(`p/${name}.txt`, { body: new Uint8Array([1]) });
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

  it('scopes a v1-only backend without v2 members', async () => {
    const raw = createInMemoryObjectStore();
    const v1: ObjectStore = {
      put: (key, input) => raw.put(key, input),
      get: (key) => raw.get(key),
      delete: (key) => raw.delete(key),
      list: (prefix) => raw.list(prefix),
      listPrefix: (prefix) => raw.listPrefix(prefix),
      copyObject: (source, destination) => raw.copyObject(source, destination),
    };
    const store = createScopedObjectStore(v1, WORKSPACE_ID);

    expect('head' in store).toBe(false);
    await store.put('a.txt', { body: new Uint8Array([1, 2]) });
    expect((await store.get('a.txt'))?.body).toEqual(new Uint8Array([1, 2]));
  });
});

describe('scoped createSignedUrl', () => {
  function signingBackend(boundLengthSign: boolean): {
    readonly backend: ObjectStoreV2;
    readonly seen: { key: string; request: SignedUrlRequest }[];
  } {
    const raw = createInMemoryObjectStore();
    const seen: { key: string; request: SignedUrlRequest }[] = [];
    const backend: ObjectStoreV2 = {
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
});
