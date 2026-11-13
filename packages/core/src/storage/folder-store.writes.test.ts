// @story US-STO-12
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { keysOf, textAt } from './contract.js';
import { useFolderFixture, utf8 } from './folder-store.fixture.test-support.js';
import { ObjectConflictError } from './object-store.js';

describe('folder store', () => {
  const fx = useFolderFixture();
  const { openStore } = fx;

  // #1835: a write the store reported done survives a crash: the bytes and the folder entry that
  // names them are flushed before it returns.
  it('flushes the written file and its folder before a write returns', async () => {
    const probe = await open(path.join(fx.root, 'reports', 'a.txt'), 'r');
    const prototype: unknown = Object.getPrototypeOf(probe);
    await probe.close();
    const synced: string[] = [];
    const sync = vi
      .spyOn(prototype as { sync: () => Promise<void> }, 'sync')
      .mockImplementation(async function (this: { fd: number }) {
        synced.push(await readlink(`/proc/self/fd/${String(this.fd)}`));
      });
    try {
      const store = openStore();
      await store.write('reports/new.txt', new TextEncoder().encode('new'), {});
      await store.write('reports/new.txt', new TextEncoder().encode('newer'), {
        ifMatch: (await store.head('reports/new.txt'))?.etag ?? '',
      });
      const folder = path.join(fx.root, 'reports');
      expect(synced.filter((at) => at === folder)).toHaveLength(2);
      expect(synced.filter((at) => path.dirname(at) === folder && at !== folder)).toHaveLength(2);
      expect(await textAt(store, 'reports/new.txt')).toBe('newer');
    } finally {
      sync.mockRestore();
    }
  });

  // #1835: the precondition used to re-resolve the key from the root, so a folder renamed inside the
  // root after the write opened it had its etag compared against another folder's file.
  it('[US-STO-12][unit][sdk] ifMatch is checked against the file in the folder the write opened, not the path', async () => {
    await mkdir(path.join(fx.root, 'impostor'));
    await writeFile(path.join(fx.root, 'impostor', 'a.txt'), 'impostor');
    const store = openStore({
      beforeCommit: async () => {
        await rename(path.join(fx.root, 'reports'), path.join(fx.root, 'opened'));
        await rename(path.join(fx.root, 'impostor'), path.join(fx.root, 'reports'));
      },
    });
    const impostorEtag = (await store.head('impostor/a.txt'))?.etag ?? '';

    await expect(
      store.write('reports/a.txt', utf8('mine'), { ifMatch: impostorEtag }),
    ).rejects.toBeInstanceOf(ObjectConflictError);
    expect(await readFile(path.join(fx.root, 'opened', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(path.join(fx.root, 'reports', 'a.txt'), 'utf8')).toBe('impostor');
  });

  // #1835: the precondition and the rename were serialised by an in-process lock only, so another
  // process (here: a second copy of the module, with its own lock table) could write in between.
  it('[US-STO-12][unit][sdk] a write in another process waits for a commit in progress, then sees its etag', async () => {
    vi.resetModules();
    const otherProcess: typeof import('./folder-store.js') = await import('./folder-store.js');
    const other = otherProcess.createFolderObjectStore(fx.root);
    const original = (await openStore().head('reports/a.txt'))?.etag ?? '';
    let theirs: Promise<unknown> | undefined;
    let settledDuringOurs = false;
    const ours = openStore({
      beforeCommit: async () => {
        theirs = other.write('reports/a.txt', utf8('theirs'), { ifMatch: original });
        settledDuringOurs = await Promise.race([
          theirs.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
        ]);
      },
    });

    await ours.write('reports/a.txt', utf8('ours'), { ifMatch: original });
    expect(settledDuringOurs).toBe(false);
    // The other copy's class: the name is what both copies share.
    await expect(theirs).rejects.toMatchObject({ name: 'ObjectConflictError' });
    expect(await readFile(path.join(fx.root, 'reports', 'a.txt'), 'utf8')).toBe('ours');
    expect((await readdir(path.join(fx.root, 'reports'))).sort()).toEqual(['2026', 'a.txt']);
  });

  it('[US-STO-12][unit][sdk] a commit lock left by a process that died is broken once it is stale', async () => {
    const store = openStore();
    let lock: string | undefined;
    const spy = openStore({
      beforeCommit: async () => {
        lock = (await readdir(path.join(fx.root, 'reports'))).find((name) =>
          name.startsWith('.%aw-lock-'),
        );
      },
    });
    await spy.write('reports/a.txt', utf8('second'), {});
    expect(lock).toBeDefined();
    const left = path.join(fx.root, 'reports', lock ?? '');
    await writeFile(left, '');
    const stale = new Date(Date.now() - 60_000);
    await utimes(left, stale, stale);

    await store.write('reports/a.txt', utf8('third'), {});
    expect(await readFile(path.join(fx.root, 'reports', 'a.txt'), 'utf8')).toBe('third');
    expect((await readdir(path.join(fx.root, 'reports'))).sort()).toEqual(['2026', 'a.txt']);
  });

  it('[US-STO-12][unit][sdk] a write is atomic: no temp file is listed and a failed body keeps the old file', async () => {
    const store = openStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(utf8('new-'));
        await gate;
        controller.enqueue(utf8('bytes'));
        controller.close();
      },
    });
    const pending = store.write('reports/slow.txt', slow, {});
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const names = await readdir(path.join(fx.root, 'reports'));
      if (names.some((name) => name.startsWith('.%aw-write-'))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await readdir(path.join(fx.root, 'reports'))).some((n) => n.startsWith('.%'))).toBe(
      true,
    );
    expect(await keysOf(store, 'reports')).toEqual(['reports/2026', 'reports/a.txt']);
    expect(await store.head('reports/slow.txt')).toBeNull();
    release?.();
    const meta = await pending;
    expect(meta.sizeBytes).toBe(9);
    expect(await textAt(store, 'reports/slow.txt')).toBe('new-bytes');

    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(utf8('partial'));
        controller.error(new Error('source broke'));
      },
    });
    await expect(store.write('reports/a.txt', failing, {})).rejects.toThrow('source broke');
    expect(await textAt(store, 'reports/a.txt')).toBe('alpha');
    expect((await readdir(path.join(fx.root, 'reports'))).sort()).toEqual([
      '2026',
      'a.txt',
      'slow.txt',
    ]);
  });

  it('[US-STO-12][unit][sdk] a write replaces a symlink at the target instead of writing through it', async () => {
    await symlink(path.join(fx.outside, 'secret.txt'), path.join(fx.root, 'target.txt'));
    const store = openStore();

    await store.write('target.txt', utf8('mine'), {});
    expect(await readFile(path.join(fx.outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
    expect((await lstat(path.join(fx.root, 'target.txt'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(fx.root, 'target.txt'), 'utf8')).toBe('mine');
  });

  it('[US-STO-12][unit][sdk] a write creates missing folders, copy and delete work on plain files', async () => {
    const store = openStore();
    await store.write('new/deep/note.md', utf8('hello'), { contentType: 'application/x-ignored' });
    expect((await store.head('new/deep/note.md'))?.contentType).toBe('text/markdown');
    await store.copy('new/deep/note.md', 'copy.md');
    expect(await textAt(store, 'copy.md')).toBe('hello');
    await store.delete('copy.md');
    await store.delete('copy.md');
    expect(await store.head('copy.md')).toBeNull();
    await store.delete('new');
    expect(await store.head('new/deep/note.md')).not.toBeNull();
    await store.copy('never.md', 'dest.md');
    expect(await store.head('dest.md')).toBeNull();
  });

  it('[US-STO-12][unit][sdk] an overwrite keeps the file mode, and a new file is no wider than 0644', async () => {
    const file = path.join(fx.root, 'reports', 'a.txt');
    // World-writable, so a umask of 002 or 022 would narrow it if the store did not restore it.
    await chmod(file, 0o666);
    const store = openStore();

    await store.write('reports/a.txt', utf8('again'), {});
    expect((await stat(file)).mode & 0o777).toBe(0o666);
    expect(await readFile(file, 'utf8')).toBe('again');
    await store.write('reports/new.txt', utf8('n'), {});
    expect((await stat(path.join(fx.root, 'reports', 'new.txt'))).mode & 0o777 & ~0o644).toBe(0);
  });
});
