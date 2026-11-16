// @story US-STO-12
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { keysOf, textAt } from './contract.js';
import { useFolderFixture, utf8 } from './folder-store.fixture.test-support.js';
import { FOLDER_WALK_MAX_ENTRIES, FolderStoreError, FolderWalkLimitError } from './folder-store.js';
import { UnsafeObjectKeyError } from './key-safety.js';
import { streamToBytes } from './streams.js';

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe('folder store', () => {
  const fx = useFolderFixture();
  const { openStore } = fx;

  // #1835: a body nobody reads used to keep its FileHandle open until the collector closed it,
  // with Node's DEP0137 warning. The store now closes the handle once the body is unreachable.
  it('closes the file of a read body that is dropped unread, with no DEP0137 warning', async () => {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('--expose-gc did not expose gc()');
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      warnings.push(warning.code ?? warning.name);
    };
    process.on('warning', onWarning);
    try {
      const store = openStore();
      const before = (await readdir('/proc/self/fd')).length;
      await (async () => {
        const object = await store.read('reports/a.txt');
        expect(object).not.toBeNull();
      })();
      expect((await readdir('/proc/self/fd')).length).toBe(before + 1);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        Reflect.apply(gc, undefined, []);
        await new Promise((resolve) => setTimeout(resolve, 10));
        if ((await readdir('/proc/self/fd')).length === before) break;
      }
      expect((await readdir('/proc/self/fd')).length).toBe(before);
      expect(warnings).not.toContain('DEP0137');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('[US-STO-12][unit][sdk] a key is the file at that path, typed by its name', async () => {
    const store = openStore();
    expect(await textAt(store, 'reports/a.txt')).toBe('alpha');
    expect(await store.head('reports/2026/b.csv')).toMatchObject({
      sizeBytes: 5,
      contentType: 'text/csv',
    });
    await writeFile(path.join(fx.root, 'reports', 'blob.unknownext'), '?');
    expect((await store.head('reports/blob.unknownext'))?.contentType).toBe(
      'application/octet-stream',
    );
    expect(await store.head('reports')).toBeNull();
    expect(await store.read('reports/missing.txt')).toBeNull();
    const ranged = await store.read('reports/a.txt', { range: { start: 1, end: 2 } });
    expect(text(await streamToBytes(ranged!.body))).toBe('lp');
  });

  it('[US-STO-12][unit][sdk] an unsafe key is refused by every member and never decoded', async () => {
    const store = openStore();
    const unsafe = ['..', 'a/../b', '%2e%2e/x', '/etc/passwd', 'a\\b', 'a\0b', 'a//b', './a'];
    for (const key of unsafe) {
      await expect(store.read(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.head(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.listPage(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
    }
    expect(await readdir(fx.base)).toEqual(['outside', 'root']);
  });

  it('[US-STO-12][unit][sdk] a named pipe is not opened for reading, so it cannot block a worker thread', async () => {
    const pipe = path.join(fx.root, 'reports', 'pipe');
    execFileSync('mkfifo', [pipe]);
    const store = openStore();
    const within = <T>(work: Promise<T>): Promise<T | 'timed out'> =>
      Promise.race([work, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), 1000))]);

    try {
      // Four heads would occupy all four libuv threads if an open blocked; the readFile needs one.
      const heads = Promise.all([1, 2, 3, 4].map(() => store.head('reports/pipe')));
      const unrelated = readFile(path.join(fx.root, 'reports', 'a.txt'), 'utf8');
      expect(await within(heads)).toEqual([null, null, null, null]);
      expect(await within(unrelated)).toBe('alpha');
      expect(await within(store.read('reports/pipe'))).toBeNull();
    } finally {
      // A blocked reader's open returns once a writer opens the pipe; without one it never would.
      try {
        closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // No reader is blocked: the pipe has nobody to release.
      }
    }
  });

  it('[US-STO-12][unit][sdk] a file the process cannot read is skipped and counted, not fatal', async () => {
    const locked = path.join(fx.root, 'reports', 'locked.txt');
    await writeFile(locked, 'nope');
    await chmod(locked, 0o000);
    const store = openStore();

    const keys = await keysOf(store, 'reports');
    expect(keys).toEqual(['reports/2026', 'reports/a.txt']);
    expect(fx.skipped).toEqual([{ links: 0, unreadable: 1 }]);
  });

  it('[US-STO-12][unit][sdk] folder names with a space list their files, and paging visits each entry once', async () => {
    await mkdir(path.join(fx.root, 'Q3 reports'), { recursive: true });
    await writeFile(path.join(fx.root, 'Q3 reports', 'n 1.txt'), 'one');
    await writeFile(path.join(fx.root, 'Q3 reports', 'n 2.txt'), 'two');
    const store = openStore();

    expect(await keysOf(store, '')).toEqual(['Q3 reports', 'reports']);
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listPage('Q3 reports', {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.entries.map((entry) => entry.key));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(keys).toEqual(['Q3 reports/n 1.txt', 'Q3 reports/n 2.txt']);
  });

  // #1835: a run's delivery pages through a granted folder. Each page used to walk the folder again
  // from the start of its current directory and warn about the same skipped entries once per page.
  it('[US-STO-12][unit][sdk] a recursive listing read page by page reads each folder once and reports its skips once', async () => {
    await mkdir(path.join(fx.root, 'p'));
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await writeFile(path.join(fx.root, 'p', `${name}.txt`), name);
    }
    await symlink(path.join(fx.outside, 'secret.txt'), path.join(fx.root, 'p', 'leak.txt'));
    let readdirs = 0;
    const store = openStore({
      beforeReaddir: () => {
        readdirs += 1;
        return Promise.resolve();
      },
    });

    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listPage('p', {
        recursive: true,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.entries.map((entry) => entry.key));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);

    expect(keys).toEqual(['p/a.txt', 'p/b.txt', 'p/c.txt', 'p/d.txt', 'p/e.txt']);
    expect(readdirs).toBe(1);
    expect(fx.skipped).toEqual([{ links: 1, unreadable: 0 }]);
  });

  it('[US-STO-12][unit][sdk] a cursor from another store, or one whose walk has ended, still resumes in the right place', async () => {
    const first = await openStore().listPage('reports', { recursive: true, limit: 1 });
    expect(first.entries.map((entry) => entry.key)).toEqual(['reports/2026/b.csv']);
    const resumed = await openStore().listPage('reports', {
      recursive: true,
      limit: 1,
      cursor: first.cursor ?? '',
    });
    expect(resumed).toMatchObject({ entries: [{ key: 'reports/a.txt' }], cursor: null });
  });

  // #1835: a walk that examines more directory entries than the cap stops with a typed error rather
  // than reading a folder of millions of names, or a tree of empty folders, to the end.
  it('[US-STO-12][unit][sdk] a walk that examines more entries than the cap fails with a typed error', async () => {
    expect(FOLDER_WALK_MAX_ENTRIES).toBe(200_000);
    await mkdir(path.join(fx.root, 'many'));
    for (let n = 0; n < 6; n += 1)
      await writeFile(path.join(fx.root, 'many', `f${String(n)}`), 'x');
    const store = openStore({ walkMaxEntries: 5 });

    await expect(store.listPage('many', { recursive: true })).rejects.toBeInstanceOf(
      FolderWalkLimitError,
    );
    await expect(store.listPage('many')).rejects.toBeInstanceOf(FolderWalkLimitError);
    // The count is one walk's, carried from page to page: `many` (7 names) fits, `many/zz` does not.
    await mkdir(path.join(fx.root, 'many', 'zz'));
    await writeFile(path.join(fx.root, 'many', 'zz', 'g'), 'x');
    const paged = openStore({ walkMaxEntries: 7 });
    const first = await paged.listPage('many', { recursive: true, limit: 2 });
    expect(first.entries).toHaveLength(2);
    let cursor = first.cursor;
    const walkRest = async (): Promise<void> => {
      while (cursor !== null) {
        cursor = (await paged.listPage('many', { recursive: true, limit: 2, cursor })).cursor;
      }
    };
    await expect(walkRest()).rejects.toBeInstanceOf(FolderWalkLimitError);
  });

  it('[US-STO-12][unit][sdk] hidden files are listed like any other, and names the key guard refuses are not', async () => {
    await writeFile(path.join(fx.root, '.hidden'), 'h');
    await writeFile(path.join(fx.root, '50%.txt'), 'foreign');
    const store = openStore();

    expect(await keysOf(store, '')).toEqual(['.hidden', 'reports']);
  });

  it('[US-STO-12][unit][sdk] a filesystem failure names the key and a code, never a host path', async () => {
    await symlink(path.join(fx.root, 'nowhere'), path.join(fx.root, 'dangling'));
    const store = openStore();
    const failed = (work: Promise<unknown>): Promise<unknown> =>
      work.then(
        () => new Error('it succeeded'),
        (error: unknown) => error,
      );

    const errors = [
      // A folder where the file goes: `rename` fails `EISDIR`.
      await failed(store.write('reports/2026', utf8('x'), {})),
      // A file where a folder goes: `ENOTDIR`.
      await failed(store.write('reports/a.txt/x.txt', utf8('x'), {})),
      // A dangling link where a folder goes.
      await failed(store.write('dangling/x.txt', utf8('x'), {})),
    ];
    await chmod(path.join(fx.root, 'reports'), 0o555);
    try {
      // A folder the process may not change: `unlink` fails `EACCES`.
      errors.push(await failed(store.delete('reports/a.txt')));
    } finally {
      await chmod(path.join(fx.root, 'reports'), 0o755);
    }

    expect(errors.map((error) => (error as Error).name)).toEqual([
      'FolderStoreError',
      'FolderStoreError',
      'FolderPathError',
      'FolderStoreError',
    ]);
    expect(errors.map((error) => (error as { code?: unknown }).code)).toEqual([
      'EISDIR',
      'ENOTDIR',
      'storage_connection_endpoint_forbidden',
      'EACCES',
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(fx.root);
      expect((error as Error).message).not.toContain(os.tmpdir());
      expect((error as Error).cause).toBeUndefined();
    }
    expect(errors[0]).toBeInstanceOf(FolderStoreError);
    expect(await readFile(path.join(fx.root, 'reports', 'a.txt'), 'utf8')).toBe('alpha');
  });
});
