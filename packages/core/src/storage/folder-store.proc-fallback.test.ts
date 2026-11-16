// @story US-STO-12
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { keysOf } from './contract.js';
import { useFolderFixture, utf8 } from './folder-store.fixture.test-support.js';
import { FolderPathError } from './folder-store.js';
import { UnsafeObjectKeyError } from './key-safety.js';
import { type ObjectStore } from './object-store.js';

describe('folder store', () => {
  const fx = useFolderFixture();
  const { openStore } = fx;

  describe('without /proc/self/fd (the path-check fallback)', () => {
    const openFallback = (): ObjectStore => openStore({ procFd: false });

    it('[US-STO-12][unit][sdk] an outside file symlink is never read or listed', async () => {
      await symlink(path.join(fx.outside, 'secret.txt'), path.join(fx.root, 'reports', 'leak.txt'));
      const store = openFallback();

      expect(await store.read('reports/leak.txt')).toBeNull();
      expect(await store.head('reports/leak.txt')).toBeNull();
      expect(await keysOf(store, 'reports', true)).toEqual(['reports/2026/b.csv', 'reports/a.txt']);
      expect(fx.skipped).toEqual([{ links: 1, unreadable: 0 }]);
    });

    it('[US-STO-12][unit][sdk] an outside directory symlink is not entered, listed or written through', async () => {
      await symlink(fx.outside, path.join(fx.root, 'linked'));
      await mkdir(path.join(fx.outside, 'inner'));
      await writeFile(path.join(fx.outside, 'inner', 'deep.txt'), 'outside-deep');
      const store = openFallback();

      expect(await store.read('linked/secret.txt')).toBeNull();
      expect(await store.read('linked/inner/deep.txt')).toBeNull();
      expect(await keysOf(store, 'linked')).toEqual([]);
      expect(await keysOf(store, 'linked/inner', true)).toEqual([]);
      expect(await keysOf(store, '')).toEqual(['reports']);
      for (const key of ['linked/new.txt', 'linked/inner/new.txt', 'linked/deeper/new.txt']) {
        await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(FolderPathError);
      }
      await store.delete('linked/inner/deep.txt');
      expect((await readdir(fx.outside, { recursive: true })).sort()).toEqual([
        'inner',
        'inner/deep.txt',
        'secret.txt',
      ]);
    });

    // #1991 A2: `O_NOFOLLOW` must apply to the name that was asked for, not to its resolved target.
    it('[US-STO-12][unit][sdk] an inside file symlink addressed directly is not read', async () => {
      await symlink(path.join(fx.root, 'reports', 'a.txt'), path.join(fx.root, 'alias.txt'));
      const store = openFallback();

      expect(await store.read('alias.txt')).toBeNull();
      expect(await store.head('alias.txt')).toBeNull();
    });

    it('[US-STO-12][unit][sdk] an inside directory alias is not read, written or deleted through', async () => {
      await symlink(path.join(fx.root, 'reports'), path.join(fx.root, 'alias'));
      const store = openFallback();

      expect(await store.read('alias/a.txt')).toBeNull();
      expect(await store.head('alias/a.txt')).toBeNull();
      await expect(store.write('alias/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
        FolderPathError,
      );
      await store.delete('alias/a.txt');
      expect((await readdir(path.join(fx.root, 'reports'))).sort()).toEqual(['2026', 'a.txt']);
    });

    it('[US-STO-12][unit][sdk] the `..` key is refused', async () => {
      const store = openFallback();
      for (const key of ['..', '../outside/secret.txt', 'reports/../../outside/secret.txt']) {
        await expect(store.read(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
        await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      }
      expect(await readFile(path.join(fx.outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
    });
  });
});
