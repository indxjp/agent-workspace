import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFolderObjectStore, type FolderSkipCounts } from './folder-store.js';
import { createLocalFilesystemObjectStore } from './local-fs-store.js';
import { createInMemoryObjectStore } from './memory-store.js';
import type { ListPageOptions, ObjectListEntry, ObjectStore } from './object-store.js';
import { listPageFrom, readBytes } from './streams.js';

function chunked(parts: readonly string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[next];
      next += 1;
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('readBytes', () => {
  it('collects a body under the cap', async () => {
    const bytes = await readBytes(chunked(['ab', 'cd']), 10);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('abcd');
  });

  it('collects a body of exactly the cap', async () => {
    const bytes = await readBytes(chunked(['ab', 'cd']), 4);
    expect(bytes?.byteLength).toBe(4);
  });

  it('answers null and cancels the source once the cap is passed', async () => {
    let cancelled = false;
    const bytes = await readBytes(
      chunked(['ab', 'cd', 'e'], () => {
        cancelled = true;
      }),
      4,
    );
    expect(bytes).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('releases the reader when a read rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('source failed');
      },
    });
    await expect(readBytes(stream, 10)).rejects.toThrow('source failed');
    expect(stream.locked).toBe(false);
  });

  it('releases the reader once the body is read', async () => {
    const stream = chunked(['ab']);
    await readBytes(stream, 10);
    expect(stream.locked).toBe(false);
  });
});

describe('listPage paging of the self-paging backends', () => {
  const body = new TextEncoder().encode('x');
  interface Opened {
    readonly store: ObjectStore;
    readonly cleanup: () => Promise<void>;
  }
  const backends: ReadonlyArray<readonly [string, () => Promise<Opened>]> = [
    [
      'memory',
      () =>
        Promise.resolve({
          store: createInMemoryObjectStore(),
          cleanup: () => Promise.resolve(),
        }),
    ],
    [
      'local filesystem',
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'aw-paging-local-'));
        return {
          store: createLocalFilesystemObjectStore(root),
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      },
    ],
    [
      'folder',
      async () => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-paging-folder-')));
        return {
          store: createFolderObjectStore(root),
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      },
    ],
  ];

  async function pages(
    store: ObjectStore,
    options: ListPageOptions,
  ): Promise<Array<{ keys: string[]; cursor: string | null }>> {
    const out: Array<{ keys: string[]; cursor: string | null }> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.listPage('p', {
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push({ keys: page.entries.map((entry) => entry.key), cursor: page.cursor });
      if (page.cursor === null) return out;
      cursor = page.cursor;
    }
    throw new Error('listPage never finished');
  }

  describe.each(backends)('%s', (_label, open) => {
    async function withFixture(run: (store: ObjectStore) => Promise<void>): Promise<void> {
      const { store, cleanup } = await open();
      try {
        for (const key of ['p/a.txt', 'p/b.txt', 'p/c/d.txt', 'p/c.txt']) {
          await store.write(key, body, {});
        }
        await run(store);
      } finally {
        await cleanup();
      }
    }

    it('pages one level in key order with a <kind>:<key> cursor', async () => {
      await withFixture(async (store) => {
        expect(await pages(store, { limit: 3 })).toEqual([
          { keys: ['p/a.txt', 'p/b.txt', 'p/c'], cursor: 'folder:p/c' },
          { keys: ['p/c.txt'], cursor: null },
        ]);
      });
    });

    it('pages recursively without an entry for the prefix itself', async () => {
      await withFixture(async (store) => {
        expect(await pages(store, { limit: 2, recursive: true })).toEqual([
          { keys: ['p/a.txt', 'p/b.txt'], cursor: 'file:p/b.txt' },
          { keys: ['p/c.txt', 'p/c/d.txt'], cursor: null },
        ]);
      });
    });

    it('resumes just before a folder whose siblings sort before its `/`', async () => {
      const { store, cleanup } = await open();
      try {
        for (const key of ['p/a-b/y.txt', 'p/a.txt', 'p/a/x.txt']) await store.write(key, body, {});
        expect(await pages(store, { limit: 2, recursive: true })).toEqual([
          { keys: ['p/a-b/y.txt', 'p/a.txt'], cursor: 'file:p/a.txt' },
          { keys: ['p/a/x.txt'], cursor: null },
        ]);
        expect(await pages(store, { limit: 2 })).toEqual([
          { keys: ['p/a', 'p/a-b'], cursor: 'folder:p/a-b' },
          { keys: ['p/a.txt'], cursor: null },
        ]);
      } finally {
        await cleanup();
      }
    });

    // The 1,000 clamp needs more than 1,000 entries to bite, so it is proved once, over 1,001
    // objects, by `defineOwnPagingContract` in `contract.ts`, which each of these backends runs.
    it('clamps a limit below 1 to 1', async () => {
      await withFixture(async (store) => {
        const one = await store.listPage('p', { limit: 0, recursive: true });
        expect(one.entries.map((entry) => entry.key)).toEqual(['p/a.txt']);
        expect(one.cursor).toBe('file:p/a.txt');
      });
    });
  });
});

describe('a paged walk resumes at its cursor instead of walking from the start', () => {
  const pad = (n: number): string => String(n).padStart(2, '0');

  async function drainKeys(
    list: (cursor: string | undefined) => Promise<{
      entries: readonly ObjectListEntry[];
      cursor: string | null;
    }>,
  ): Promise<{ keys: string[]; pages: number }> {
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(cursor);
      pages += 1;
      keys.push(...page.entries.map((entry) => entry.key));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return { keys, pages };
  }

  it('pulls about one page of entries per page from a 3,000-entry walk', async () => {
    const all: ObjectListEntry[] = Array.from({ length: 3000 }, (_, n) => ({
      kind: 'file',
      key: `p/${String(n).padStart(4, '0')}.txt`,
      sizeBytes: 1,
      contentType: null,
      lastModified: new Date(0),
    }));
    let walks = 0;
    let pulled = 0;
    async function* walk(after: string | undefined): AsyncGenerator<ObjectListEntry> {
      walks += 1;
      for (const entry of all) {
        if (after !== undefined && entry.key < after) continue;
        pulled += 1;
        yield await Promise.resolve(entry);
      }
    }
    const listing = {
      level: (_: string, after: string | undefined) => walk(after),
      tree: () => walk(undefined),
    };

    const { keys, pages } = await drainKeys((cursor) =>
      listPageFrom(listing, 'p', cursor === undefined ? {} : { cursor }),
    );

    expect(keys).toEqual(all.map((entry) => entry.key));
    expect(pages).toBe(3);
    expect(walks).toBe(3);
    // Each page pulls its own entries, the one its cursor names and the one that proves there is more.
    expect(pulled).toBeLessThanOrEqual(3000 + 2 * 3);
  });

  it('reports what a folder store page skipped only for the part of the tree that page walked', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-paging-skip-')));
    try {
      await mkdir(path.join(root, 'p', 'z'), { recursive: true });
      await writeFile(path.join(root, 'p', 'a.txt'), 'a');
      await writeFile(path.join(root, 'p', 'b.txt'), 'b');
      await symlink(path.join(root, 'p', 'a.txt'), path.join(root, 'p', 'z', 'link.txt'));
      const skipped: FolderSkipCounts[] = [];
      const store = createFolderObjectStore(root, { onSkipped: (counts) => skipped.push(counts) });

      const first = await store.listPage('p', { recursive: true, limit: 1 });
      expect(first).toMatchObject({ entries: [{ key: 'p/a.txt' }], cursor: 'file:p/a.txt' });
      // The page stopped at `p/b.txt`, before `p/z`: nothing it walked was skipped.
      expect(skipped).toEqual([]);

      const second = await store.listPage('p', {
        recursive: true,
        limit: 1,
        cursor: 'file:p/a.txt',
      });
      expect(second).toMatchObject({ entries: [{ key: 'p/b.txt' }], cursor: null });
      expect(skipped).toEqual([{ links: 1, unreadable: 0 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads each folder of a 3,000-file folder store tree about once', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-paging-walk-')));
    try {
      for (let folder = 0; folder < 30; folder += 1) {
        await mkdir(path.join(root, 'p', `d${pad(folder)}`), { recursive: true });
        await Promise.all(
          Array.from({ length: 100 }, (_, file) =>
            writeFile(path.join(root, 'p', `d${pad(folder)}`, `f${pad(file)}.txt`), 'x'),
          ),
        );
      }
      let readdirs = 0;
      const store = createFolderObjectStore(root, {
        beforeReaddir: () => {
          readdirs += 1;
          return Promise.resolve();
        },
      });

      const { keys, pages } = await drainKeys((cursor) =>
        store.listPage('p', { recursive: true, ...(cursor === undefined ? {} : { cursor }) }),
      );

      expect(keys).toHaveLength(3000);
      expect(keys).toEqual([...keys].sort());
      expect(pages).toBe(3);
      // `p` once a page, each of its 30 folders once, and two folders again at each page boundary:
      // the cursor's own and the one the previous page peeked into. A walk from the start is 93.
      expect(readdirs).toBe(3 + 30 + 2 * 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
