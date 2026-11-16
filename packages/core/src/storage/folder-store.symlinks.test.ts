// @story US-STO-12
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { keysOf, textAt } from './contract.js';
import { useFolderFixture, utf8 } from './folder-store.fixture.test-support.js';
import { FolderPathError } from './folder-store.js';

describe('folder store', () => {
  const fx = useFolderFixture();
  const { openStore } = fx;

  it('[US-STO-12][unit][sdk] a file symlink that leaves the folder is never read or listed', async () => {
    await symlink(path.join(fx.outside, 'secret.txt'), path.join(fx.root, 'reports', 'leak.txt'));
    const store = openStore();

    expect(await store.read('reports/leak.txt')).toBeNull();
    expect(await store.head('reports/leak.txt')).toBeNull();
    expect(await store.read('reports/leak.txt')).toBeNull();
    const keys = [...(await keysOf(store, 'reports')), ...(await keysOf(store, 'reports', true))];
    expect(keys).not.toContain('reports/leak.txt');
    expect(keys).toContain('reports/a.txt');
    expect(fx.skipped.every((counts) => counts.links === 1 && counts.unreadable === 0)).toBe(true);
    expect(fx.skipped.length).toBeGreaterThan(0);
  });

  it('[US-STO-12][unit][sdk] a directory symlink that leaves the folder is not entered, listed or written through', async () => {
    await symlink(fx.outside, path.join(fx.root, 'linked'));
    const store = openStore();

    expect(await store.read('linked/secret.txt')).toBeNull();
    expect(await store.head('linked/secret.txt')).toBeNull();
    expect(await keysOf(store, '')).toEqual(['reports']);
    expect(await keysOf(store, 'linked')).toEqual([]);
    expect(await keysOf(store, 'linked', true)).toEqual([]);
    expect(fx.skipped).toContainEqual({ links: 1, unreadable: 0 });
    // Through the link as a middle component: only what was opened decides, not the path.
    await mkdir(path.join(fx.outside, 'inner'));
    await writeFile(path.join(fx.outside, 'inner', 'deep.txt'), 'outside-deep');
    expect(await keysOf(store, 'linked/inner')).toEqual([]);
    expect(await keysOf(store, 'linked/inner', true)).toEqual([]);
    expect((await store.listPage('linked/inner', { recursive: true })).entries).toEqual([]);
    expect(await store.read('linked/inner/deep.txt')).toBeNull();

    await expect(store.write('linked/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await expect(store.write('linked/deeper/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await expect(store.delete('linked/secret.txt')).resolves.toBeUndefined();
    expect((await readdir(fx.outside)).sort()).toEqual(['inner', 'secret.txt']);
    expect(await readFile(path.join(fx.outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
  });

  it('[US-STO-12][unit][sdk] a file symlink is refused even when it stays inside the folder, so reads and listings agree', async () => {
    await symlink(path.join(fx.root, 'reports', 'a.txt'), path.join(fx.root, 'alias.txt'));
    const store = openStore();

    expect(await store.read('alias.txt')).toBeNull();
    expect(await store.read('alias.txt')).toBeNull();
    expect(await store.head('alias.txt')).toBeNull();
    expect(await keysOf(store, '')).toEqual(['reports']);
    expect(await keysOf(store, 'alias.txt', true)).toEqual([]);
    expect(fx.skipped).toEqual([{ links: 1, unreadable: 0 }]);
  });

  // #1835: a folder linked from inside the root to inside the root is part of the folder: listed,
  // read and written through like the folder it names. Only what was opened decides (Linux).
  it('[US-STO-12][unit][sdk] a directory symlink that stays inside the folder is listed, read and written through', async () => {
    await symlink(path.join(fx.root, 'reports'), path.join(fx.root, 'again'));
    const store = openStore();

    expect(await keysOf(store, '')).toEqual(['again', 'reports']);
    expect(await keysOf(store, 'again')).toEqual(['again/2026', 'again/a.txt']);
    expect(await keysOf(store, '', true)).toEqual([
      'again/2026/b.csv',
      'again/a.txt',
      'reports/2026/b.csv',
      'reports/a.txt',
    ]);
    expect(await textAt(store, 'again/a.txt')).toBe('alpha');
    await store.write('again/new.txt', utf8('through'), {});
    expect(await readFile(path.join(fx.root, 'reports', 'new.txt'), 'utf8')).toBe('through');
    await store.delete('again/new.txt');
    expect(await readdir(path.join(fx.root, 'reports'))).not.toContain('new.txt');
    expect(fx.skipped).toEqual([]);
  });

  it('[US-STO-12][unit][sdk] a directory symlink back to a folder it is inside is counted, not walked again', async () => {
    await symlink(path.join(fx.root, 'reports'), path.join(fx.root, 'reports', '2026', 'up'));
    await symlink(fx.root, path.join(fx.root, 'top'));
    const store = openStore();

    expect(await keysOf(store, '', true)).toEqual(['reports/2026/b.csv', 'reports/a.txt']);
    expect(fx.skipped).toEqual([{ links: 2, unreadable: 0 }]);
    fx.skipped = [];
    expect(await keysOf(store, 'reports/2026')).toEqual(['reports/2026/b.csv']);
    expect(fx.skipped).toEqual([{ links: 1, unreadable: 0 }]);
  });

  it('[US-STO-12][unit][sdk] a directory swapped for a symlink between the check and the open serves nothing', async () => {
    await writeFile(path.join(fx.outside, 'a.txt'), 'outside-copy');
    let swapped = false;
    const store = openStore({
      beforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(path.join(fx.root, 'reports'), path.join(fx.base, 'moved'));
        await symlink(fx.outside, path.join(fx.root, 'reports'));
      },
    });

    expect(await store.read('reports/a.txt')).toBeNull();
    expect(await store.head('reports/a.txt')).toBeNull();
    expect(swapped).toBe(true);
  });

  it('[US-STO-12][unit][sdk] a link as a middle component is never written or deleted through, even to an existing outside folder', async () => {
    await symlink(fx.outside, path.join(fx.root, 'linked'));
    await mkdir(path.join(fx.outside, 'inner'));
    await writeFile(path.join(fx.outside, 'inner', 'deep.txt'), 'outside-deep');
    const store = openStore();

    await expect(store.write('linked/inner/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await store.delete('linked/inner/deep.txt');
    expect(await readdir(path.join(fx.outside, 'inner'))).toEqual(['deep.txt']);
    expect(await readFile(path.join(fx.outside, 'inner', 'deep.txt'), 'utf8')).toBe('outside-deep');
  });
});
